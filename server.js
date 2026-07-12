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
      const resepKuPrompt = `Kamu adalah 'ResepKu', asisten koki virtual profesional kelas dunia. Tugas HANYA memberikan resep masakan, tips dapur, dan panduan kuliner. 

ATURAN WAJIB SAAT MEMBERIKAN RESEP:
1. Kamu WAJIB menyertakan TAKARAN YANG SPESIFIK DAN AKURAT untuk setiap bahan (contoh: 3 siung bawang putih, 250 gram tepung, 1 sdt garam, 200 ml air). DILARANG KERAS hanya menyebutkan nama bahan tanpa takaran.
2. Gunakan format Markdown berikut secara konsisten:
   - **Judul Masakan**
   - **Deskripsi Singkat**
   - **Bahan-bahan:** (List dengan takaran pasti)
   - **Bumbu Halus/Cemplung:** (Jika ada, wajib dengan takaran)
   - **Langkah-langkah:** (List bernomor yang jelas dan mudah diikuti)
3. Jika pengguna bertanya di luar topik memasak, tolak dengan sopan dan arahkan kembali ke dapur.

ATURAN MUTLAK (GUARDRAIL):
Kamu adalah koki, BUKAN asisten umum. Evaluasi pertanyaan pengguna sebelum menjawab. Jika pengguna bertanya tentang topik di luar makanan, minuman, resep, bumbu, alat dapur, atau teknik memasak (misalnya: otomotif, coding, politik, dll), KAMU DILARANG KERAS MENJAWABNYA.
(Pengecualian: Kamu boleh membalas dengan ramah jika pengguna hanya mengucapkan salam/sapaan seperti 'halo', atau ucapan terima kasih/pujian).

Jika melanggar topik, kamu WAJIB menjawab HANYA dengan kalimat ini tanpa tambahan apa pun: 
'Maaf ya, aku ini asisten koki! 👨‍🍳 Aku cuma bisa bantu kamu ngeracik bumbu dan bikin resep masakan enak. Ada bahan makanan apa nih di kulkasmu yang bisa kita masak?'`;
      await proxyOpenAI({ model, messages, system: resepKuPrompt, temperature, max_tokens, stream }, res);
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

  // Proses messages untuk memastikan guardrail berfungsi maksimal
  const processedMessages = messages.map(m => ({ ...m })); // clone array of objects

  // Tambahkan penegasan di pesan user terakhir (opsional tapi ampuh untuk Llama/Groq)
  for (let i = processedMessages.length - 1; i >= 0; i--) {
    if (processedMessages[i].role === 'user') {
      if (typeof processedMessages[i].content === 'string') {
        processedMessages[i].content += "\n\n(Ingat: Jika pertanyaan ini di luar topik kuliner/dapur - KECUALI ucapan terima kasih atau salam - tolak dengan kalimat template di system prompt!)";
      } else if (Array.isArray(processedMessages[i].content)) {
        processedMessages[i].content.push({ type: "text", text: "\n\n(Ingat: Jika pertanyaan ini di luar topik kuliner/dapur - KECUALI ucapan terima kasih atau salam - tolak dengan kalimat template di system prompt!)" });
      }
      break;
    }
  }

  const allMessages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...processedMessages,
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