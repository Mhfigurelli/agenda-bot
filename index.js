const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { MessagingResponse } = require('twilio').twiml;
const { parse, format } = require('date-fns');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));

// Verificar variáveis de ambiente
const requiredEnvVars = ['DEEPSEEK_API_KEY', 'GOOGLE_CREDENTIALS', 'CALENDAR_ID'];
requiredEnvVars.forEach((envVar) => {
  if (!process.env[envVar]) {
    console.error(`❌ Variável de ambiente ${envVar} não definida.`);
    process.exit(1);
  }
});

const historicoConversas = {};

app.post('/whatsapp', async (req, res) => {
  const telefone = req.body.From;
  const msg = req.body && req.body.Body ? req.body.Body.trim() : '';

  if (!historicoConversas[telefone]) {
    historicoConversas[telefone] = [
      {
        role: 'system',
        content: `
Você é um atendente virtual da clínica da Dra. Carolina Figurelli, urologista em Porto Alegre, que atende no Medplex Santana – Rua Gomes Jardim, 201 – sala 1602.

Durante a conversa com o paciente, colete:
- nome_completo
- tipo_atendimento: "convênio" ou "particular"
- nome_convenio (se tipo_atendimento for "convênio", senão null)
- data_preferencial (formato: dd/MM/yyyy)
- horario_preferencial (formato: HH:mm)

Ofereça no máximo duas opções de horário para cada dia, verificando disponibilidade.

Responda em português do Brasil, com tom profissional e amigável. No final da resposta, retorne SEMPRE um JSON com as chaves: {"nome_completo": null, "tipo_atendimento": null, "nome_convenio": null, "data_preferencial": null, "horario_preferencial": null}, preenchendo apenas os dados já coletados. Separe o texto do JSON com "---". Exemplo:
Olá, qual é o seu nome completo?
---
{"nome_completo": null, "tipo_atendimento": null, "nome_convenio": null, "data_preferencial": null, "horario_preferencial": null}
        `
      }
    ];
  }

  historicoConversas[telefone].push({ role: 'user', content: msg });

  let mensagemPaciente = '';
  let dadosJson = {};

  try {
    const resp = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: historicoConversas[telefone],
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const respostaIA = resp.data.choices[0].message.content;
    historicoConversas[telefone].push({ role: 'assistant', content: respostaIA });

    try {
      const partes = respostaIA.split('---');
      mensagemPaciente = partes[0]?.trim() || 'Sem mensagem de resposta';
      if (partes.length > 1 && partes[1].trim()) {
        dadosJson = JSON.parse(partes[1]);
        console.log('📦 JSON recebido:', dadosJson);
      } else {
        console.log('ℹ️ JSON não encontrado na resposta');
      }

      if (
        dadosJson.nome_completo &&
        dadosJson.data_preferencial &&
        dadosJson.horario_preferencial
      ) {
        try {
          const dataParsed = parse(dadosJson.data_preferencial, 'dd/MM/yyyy', new Date());
          const horarioParsed = parse(dadosJson.horario_preferencial, 'HH:mm', new Date());
          const dadosFormatados = {
            nome: dadosJson.nome_completo,
            tipo_atendimento: dadosJson.tipo_atendimento,
            convenio: dadosJson.nome_convenio,
            data: format(dataParsed, 'yyyy-MM-dd'),
            horario: format(horarioParsed, 'HH:mm')
          };

          console.log('📤 Agendando com:', dadosFormatados);
          await agendarConsultaGoogleCalendar(dadosFormatados);
          mensagemPaciente += '\n\n✅ Consulta agendada com sucesso!';
        } catch (e) {
          console.error('❌ Erro ao formatar data/horário:', e.message);
          mensagemPaciente = 'Desculpe, o formato da data ou horário está inválido. Por favor, use o formato dd/MM/yyyy para data e HH:mm para horário.';
        }
      } else {
        console.log('ℹ️ JSON incompleto, aguardando mais dados...');
      }
    } catch (e) {
      console.error('❌ Erro ao interpretar JSON:', e.message);
      mensagemPaciente = 'Desculpe, houve um problema ao processar sua solicitação. Tente novamente.';
    }
  } catch (err) {
    console.error('❌ DeepSeek Error:', err.message);
    mensagemPaciente = 'Desculpe, ocorreu um erro ao tentar responder. Pode tentar de novo?';
  }

  const twiml = new MessagingResponse();
  twiml.message(mensagemPaciente);
  res.type('text/xml').send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🟢 Servidor rodando na porta ${port}`);
});

async function agendarConsultaGoogleCalendar(dados) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  const calendar = google.calendar({ version: 'v3', auth });

  const startDateTime = new Date(`${dados.data}T${dados.horario}:00-03:00`);
  const endDateTime = new Date(startDateTime.getTime() + 30 * 60000);

  const isDisponivel = await verificarDisponibilidade(calendar, dados);
  if (!isDisponivel) {
    throw new Error('Horário já ocupado');
  }

  const evento = {
    summary: `Consulta: ${dados.nome}`,
    description: `Atendimento: ${dados.tipo_atendimento}${dados.convenio ? ` - Convênio: ${dados.convenio}` : ''}`,
    start: { dateTime: startDateTime.toISOString(), timeZone: 'America/Sao_Paulo' },
    end: { dateTime: endDateTime.toISOString(), timeZone: 'America/Sao_Paulo' }
  };

  try {
    console.log('📅 Evento a ser criado:', JSON.stringify(evento, null, 2));
    await calendar.events.insert({
      calendarId: process.env.CALENDAR_ID,
      resource: evento
    });
    console.log('✅ Consulta agendada com sucesso!');
  } catch (err) {
    console.error('❌ Erro ao agendar no Google Calendar:', err.message);
    throw err;
  }
}

async function verificarDisponibilidade(calendar, dados) {
  const startDateTime = new Date(`${dados.data}T${dados.horario}:00-03:00`);
  const endDateTime = new Date(startDateTime.getTime() + 30 * 60000);

  try {
    const eventos = await calendar.events.list({
      calendarId: process.env.CALENDAR_ID,
      timeMin: startDateTime.toISOString(),
      timeMax: endDateTime.toISOString(),
      timeZone: 'America/Sao_Paulo'
    });
    return eventos.data.items.length === 0;
  } catch (err) {
    console.error('❌ Erro ao verificar disponibilidade:', err.message);
    throw err;
  }
}
