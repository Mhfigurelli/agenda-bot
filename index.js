const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { MessagingResponse } = require('twilio').twiml;
const { parse, format, addDays, nextWednesday } = require('date-fns');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));

// Verificar variáveis de ambiente
const requiredEnvVars = ['DEEPSEEK_API_KEY', 'GOOGLE_CREDENTIALS', 'CALENDAR_ID'];
let envError = null;
requiredEnvVars.forEach((envVar) => {
  if (!process.env[envVar]) {
    envError = `❌ Variável de ambiente ${envVar} não definida.`;
    console.error(envError);
  }
});

// Validar GOOGLE_CREDENTIALS
let googleCredentials;
try {
  googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  console.log('🔑 GOOGLE_CREDENTIALS client_email:', googleCredentials.client_email);
} catch (e) {
  envError = `❌ Erro ao parsear GOOGLE_CREDENTIALS: ${e.message}`;
  console.error(envError);
}

console.log('📅 CALENDAR_ID:', process.env.CALENDAR_ID);
console.log('🔐 DEEPSEEK_API_KEY configurada:', !!process.env.DEEPSEEK_API_KEY);

if (envError) {
  console.error('🚫 Servidor não iniciado devido a erros de configuração.');
  process.exit(1);
}

const historicoConversas = {};

// Obter a data atual no formato dd/MM/yyyy
const hoje = format(new Date(), 'dd/MM/yyyy');

app.post('/whatsapp', async (req, res) => {
  const telefone = req.body.From;
  const msg = req.body && req.body.Body ? req.body.Body.trim() : '';

  if (!historicoConversas[telefone]) {
    historicoConversas[telefone] = [
      {
        role: 'system',
        content: `
Você é um atendente virtual da clínica da Dra. Carolina Figurelli, urologista em Porto Alegre, que atende no Medplex Santana – Rua Gomes Jardim, 201 – sala 1602. Hoje é ${hoje} (quarta-feira).

Inicie a conversa com: "Bem-vindo(a) ao agendamento da Dra. Carolina Figurelli, como posso ajudar?"

Durante a conversa com o paciente, colete:
- nome_completo (nome completo do paciente, ex.: "João Silva")
- tipo_atendimento: "convênio" ou "particular"
- nome_convenio (nome do convênio se tipo_atendimento for "convênio", senão null, ex.: "Unimed")
- data_preferencial (data no formato exato dd/MM/yyyy, ex.: "23/07/2025")
- horario_preferencial (horário no formato exato HH:mm, ex.: "09:00")

Instruções:
1. Pergunte um dado por vez, na ordem: nome, tipo de atendimento, convênio (se necessário), data, horário.
2. Para a data, priorize entender linguagem natural e converta para dd/MM/yyyy com base na data atual (${hoje}). Aceite expressões como:
   - "hoje" → "${hoje}"
   - "amanhã" → "${format(addDays(new Date(), 1), 'dd/MM/yyyy')}"
   - "quarta da próxima semana" → "${format(nextWednesday(addDays(new Date(), 7)), 'dd/MM/yyyy')}"
   - "próxima sexta" → próxima sexta-feira após ${hoje}
   - "daqui a dois dias" → "${format(addDays(new Date(), 2), 'dd/MM/yyyy')}"
   - "terça" → próxima terça-feira após ${hoje}
   Valide que a data é igual ou posterior a hoje (${hoje}). Se a data for ambígua (ex.: "quarta" sem especificar qual), pergunte se é a próxima quarta-feira (ex.: "${format(nextWednesday(new Date()), 'dd/MM/yyyy')}") ou peça a data no formato dd/MM/yyyy.
3. Para o horário, priorize entender linguagem natural e converta para HH:mm. Aceite expressões como:
   - "às 9" ou "9h" → "09:00" (assuma manhã, a menos que especificado)
   - "15 horas" ou "às 15" → "15:00"
   - "9 da noite" → "21:00"
   - "meio-dia" → "12:00"
   - "cinco da tarde" → "17:00"
   Se o horário for ambíguo (ex.: "às 5" sem "manhã" ou "tarde"), pergunte se é manhã ou tarde. Se inválido, peça para corrigir (ex.: "Por favor, informe o horário como 'às 9', '15 horas', ou no formato HH:mm, como 09:00").
4. Ofereça no máximo duas opções de horário para cada dia, verificando disponibilidade.
5. Responda em português do Brasil, com tom profissional, amigável e natural, como um atendente humano.
6. No final da resposta, retorne SEMPRE um JSON válido com as chaves: {"nome_completo": null, "tipo_atendimento": null, "nome_convenio": null, "data_preferencial": null, "horario_preferencial": null}, preenchendo apenas os dados já coletados. Separe o texto do JSON com "---".
7. Não inclua nenhum texto ou caracteres adicionais (como "*" ou explicações) após o "---", apenas o JSON.

Exemplo de resposta inicial:
Bem-vindo(a) ao agendamento da Dra. Carolina Figurelli, como posso ajudar?
---
{"nome_completo": null, "tipo_atendimento": null, "nome_convenio": null, "data_preferencial": null, "horario_preferencial": null}

Exemplo com dados parciais:
Olá, Marcelo! Você prefere atendimento particular ou por convênio?
---
{"nome_completo": "Marcelo Figurelli", "tipo_atendimento": null, "nome_convenio": null, "data_preferencial": null, "horario_preferencial": null}

Exemplo de validação de data:
Você quis dizer a próxima quarta-feira (${format(nextWednesday(new Date()), 'dd/MM/yyyy')})? Ou informe a data no formato dd/MM/yyyy, como 23/07/2025.
---
{"nome_completo": "Marcelo Figurelli", "tipo_atendimento": "convênio", "nome_convenio": "Unimed", "data_preferencial": null, "horario_preferencial": null}

Exemplo de validação de horário:
Você quis dizer 05:00 da manhã ou 17:00 da tarde? Ou informe o horário como 'às 9', '15 horas', ou no formato HH:mm, como 09:00.
---
{"nome_completo": "Marcelo Figurelli", "tipo_atendimento": "convênio", "nome_convenio": "Unimed", "data_preferencial": "30/07/2025", "horario_preferencial": null}
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
        // Remover possíveis caracteres inválidos ou texto adicional
        const jsonStr = partes[1].trim().replace(/[\*`]/g, '');
        try {
          dadosJson = JSON.parse(jsonStr);
          console.log('📦 JSON recebido:', dadosJson);
          console.log('📥 Mensagem do usuário:', msg);
        } catch (e) {
          console.error('❌ Erro ao parsear JSON:', e.message, 'JSON bruto:', jsonStr);
          mensagemPaciente = 'Desculpe, houve um problema ao processar sua solicitação. Por favor, forneça os dados no formato correto.';
        }
      } else {
        console.log('ℹ️ JSON não encontrado na resposta');
        mensagemPaciente = 'Desculpe, por favor forneça os dados no formato correto.';
      }

      if (
        dadosJson.nome_completo &&
        dadosJson.data_preferencial &&
        dadosJson.horario_preferencial
      ) {
        try {
          const dataParsed = parse(dadosJson.data_preferencial, 'dd/MM/yyyy', new Date());
          const horarioParsed = parse(dadosJson.horario_preferencial, 'HH:mm', new Date());
          if (isNaN(dataParsed.getTime()) || isNaN(horarioParsed.getTime())) {
            throw new Error('Data ou horário inválido');
          }
          // Validar se a data é igual ou posterior à data atual
          const hojeParsed = parse(hoje, 'dd/MM/yyyy', new Date());
          if (dataParsed < hojeParsed) {
            throw new Error('Data anterior ao dia atual');
          }
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
          mensagemPaciente = `Desculpe, não consegui entender a data ou horário. Por favor, use termos como "amanhã", "quarta da próxima semana", "às 9", "15 horas", ou os formatos dd/MM/yyyy (ex.: 23/07/2025) e HH:mm (ex.: 09:00).${e.message.includes('anterior') ? ` A data deve ser hoje (${hoje}) ou futura.` : ''}`;
        }
      } else {
        console.log('ℹ️ JSON incompleto, aguardando mais dados...');
      }
    } catch (e) {
      console.error('❌ Erro ao interpretar JSON:', e.message);
      mensagemPaciente = 'Desculpe, houve um problema ao processar sua solicitação. Por favor, forneça os dados no formato correto.';
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
    credentials: googleCredentials,
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
