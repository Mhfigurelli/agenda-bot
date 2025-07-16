const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { MessagingResponse } = require('twilio').twiml;
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));

const historicoConversas = {};

app.post('/whatsapp', async (req, res) => {
  const telefone = req.body.From;
  const msg = req.body && req.body.Body ? req.body.Body.trim() : '';

  if (!historicoConversas[telefone]) {
    const dataAtual = new Date().toLocaleDateString('pt-BR');

    historicoConversas[telefone] = [
      {
        role: 'system',
        content: `
Você é um atendente virtual da clínica da Dra. Carolina Figurelli, urologista em Porto Alegre, que atende no Medplex Santana – Rua Gomes Jardim, 201 – sala 1602.

Hoje é: ${dataAtual}. Use essa data como referência para interpretar datas relativas como "próxima quarta".

Durante a conversa com o paciente, colete:
- nome completo
- tipo de atendimento: convênio ou particular
- nome do convênio (se aplicável)
- data preferida (formato: 2025-07-05)
- horário preferido (formato: 14:00)

Se o paciente informar um convênio (ex: Unimed, Bradesco, etc), o campo "tipo_atendimento" deve ser "convênio", e o nome do convênio deve ir no campo "convenio".

Não use "particular Unimed" nem confunda convênio com atendimento particular.

Ofereça no máximo duas opções de horário para cada dia.

No final da resposta, retorne SEMPRE o JSON consolidado com esses dados. Mesmo que nem todos os dados tenham sido preenchidos ainda, mantenha o JSON com as chaves e valores \`null\`.

Responda em português do Brasil. Separe o texto do JSON com \`---\`.
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

    const partes = respostaIA.split('---');
    mensagemPaciente = partes[0].trim();

    try {
      dadosJson = JSON.parse(partes[1]);
      console.log('📦 JSON:', dadosJson);

      if (dadosJson.nome && dadosJson.data && dadosJson.horario) {
        await agendarConsultaGoogleCalendar(dadosJson);
        console.log('✅ Consulta agendada no Google Calendar');
      }

    } catch (e) {
      console.error('❌ Erro ao interpretar JSON:', e.message);
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

// 🔧 Função para agendar no Google Calendar
async function agendarConsultaGoogleCalendar(dados) {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  const calendar = google.calendar({ version: 'v3', auth });

  const dataFormatada = dados.data;
  const horarioFormatado = dados.horario;

  const evento = {
    summary: `Consulta: ${dados.nome}`,
    description: `Atendimento: ${dados.tipo_atendimento}${dados.convenio ? ' - Convênio: ' + dados.convenio : ''}`,
    start: {
      dateTime: `${dataFormatada}T${horarioFormatado}:00`,
      timeZone: 'America/Sao_Paulo'
    },
    end: {
      dateTime: `${dataFormatada}T${incrementaMeiaHora(horarioFormatado)}`,
      timeZone: 'America/Sao_Paulo'
    }
  };

  await calendar.events.insert({
    calendarId: process.env.CALENDAR_ID,
    resource: evento
  });
}

function incrementaMeiaHora(horario) {
  const [h, m] = horario.split(':').map(Number);
  const novaData = new Date();
  novaData.setHours(h);
  novaData.setMinutes(m + 30);
  return novaData.toTimeString().slice(0, 5) + ':00';
}
