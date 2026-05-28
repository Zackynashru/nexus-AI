// ══════════════════════════════════════════════════════════════
//  NexusAI Backend Proxy Server
//  Node.js + Express — aman menyimpan API key di server
// ══════════════════════════════════════════════════════════════

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security & Middleware ───────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',  
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '50kb' }));

// Rate limiter — max 30 request per menit per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Terlalu banyak request. Coba lagi dalam 1 menit.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ─── Serve Frontend ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health Check ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    providers: {
      claude: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY, // Ini dipakai buat Groq juga
    },
  });
});

// ─── Chat Endpoint ───────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const {
    provider   = 'openai', // Defaultnya ubah ke openai biar langsung masuk ke Groq
    model      = 'llama3-70b-8192',
    messages   = [],
    system     = '',
    temperature = 0.7,
    max_tokens  = 1024,
    stream      = true,
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages tidak boleh kosong.' });
  }
  if (messages.length > 100) {
    return res.status(400).json({ error: 'Terlalu banyak pesan (max 100).' });
  }

  try {
    if (provider === 'claude') {
      await proxyClaude({ model, messages, system, temperature, max_tokens, stream }, res);
    } else if (provider === 'openai') {
      // Fungsi OpenAI kita bajak buat Groq
      await proxyOpenAI({ model, messages, system, temperature, max_tokens, stream }, res);
    } else {
      res.status(400).json({ error: 'Provider tidak valid.' });
    }
  } catch (err) {
    console.error('[API Error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ─── Claude Proxy ────────────────────────────────────────────
async function proxyClaude({ model, messages, system, temperature, max_tokens, stream }, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY tidak dikonfigurasi di server.');

  const body = {
    model,
    messages,
    max_tokens: parseInt(max_tokens),
    temperature: parseFloat(temperature),
    stream,
  };
  if (system) body.system = system;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Claude API error: ${err?.error?.message || 'Unknown error'}`);
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    response.body.pipeTo(new WritableStream({
      write(chunk) { res.write(chunk) },
      close()      { res.end() },
    }));
  } else {
    res.json(await response.json());
  }
}

// ─── OpenAI / Groq Proxy ────────────────────────────────────────────
async function proxyOpenAI({ model, messages, system, temperature, max_tokens, stream }, res) {
  const apiKey = process.env.OPENAI_API_KEY; // Masukkan API Key Groq-mu di variabel ini
  if (!apiKey) throw new Error('API_KEY tidak dikonfigurasi di server.');

  const allMessages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages,
  ];

  // URL OpenAI sudah diganti jadi URL Groq
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages:   allMessages,
      max_tokens: parseInt(max_tokens),
      temperature: parseFloat(temperature),
      stream,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`API error: ${err?.error?.message || 'Unknown error'}`);
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    response.body.pipeTo(new WritableStream({
      write(chunk) { res.write(chunk) },
      close()      { res.end() },
    }));
  } else {
    res.json(await response.json());
  }
}

// ─── Fallback ────────────────────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║   NexusAI Backend — PORT ${PORT}    ║
  ╠══════════════════════════════════╣
  ║  Claude : ${process.env.ANTHROPIC_API_KEY ? '✅ Siap' : '❌ Belum diset'}                ║
  ║  Groq   : ${process.env.OPENAI_API_KEY ? '✅ Siap' : '❌ Belum diset'}                ║
  ╚══════════════════════════════════╝
  `);
});

module.exports = app;