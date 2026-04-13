/**
 * Trend Controls — Gerador de Relatórios HVAC
 * server.js — Express + Puppeteer
 *
 * Uso: node server.js → http://localhost:3000
 */

const express   = require('express');
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Folders ────────────────────────────────────────────────────────────────
const IMG_DIR = path.join(__dirname, 'img');  // permanent assets (covers, signatures)
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/img', express.static(IMG_DIR));   // serve saved images

// ── Logo ───────────────────────────────────────────────────────────────────
app.get('/logo.png', (req, res) => {
  const p = path.join(__dirname, 'logo.png');
  fs.existsSync(p) ? res.sendFile(p) : res.status(404).send('logo.png not found');
});

// ── Banco JSON (export / import / auto-save) ───────────────────────────────
app.get('/api/banco', (req, res) => {
  const p = path.join(__dirname, 'banco.json');
  res.json(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { techs: [], clients: [] });
});

app.post('/api/banco', (req, res) => {
  fs.writeFileSync(path.join(__dirname, 'banco.json'), JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// ── Report images stay in memory (base64) — no disk saving ───────────────
// The front-end sends dataUrl directly; we just echo it back so the
// flow stays the same without touching the filesystem.
app.post('/api/upload-image', (req, res) => {
  const { dataUrl, caption } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'no dataUrl' });
  res.json({ url: dataUrl, caption: caption || '' });
});

// ── List permanent assets (covers, signatures) from /img root ─────────────
app.get('/api/assets', (req, res) => {
  const files = fs.readdirSync(IMG_DIR)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))  // only files in root, not uploads/
    .map(f => ({ url: `/img/${f}`, name: f }));
  res.json(files);
});

// ── Upload permanent asset → save to /img root ────────────────────────────
app.post('/api/assets', (req, res) => {
  try {
    const { dataUrl, name } = req.body;
    if (!dataUrl) return res.status(400).json({ error: 'no dataUrl' });
    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'invalid dataUrl' });
    const ext   = match[1].split('/')[1].replace('jpeg','jpg');
    const buf   = Buffer.from(match[2], 'base64');
    // use provided name or random
    const safe  = (name || crypto.randomBytes(8).toString('hex'))
      .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
      .replace(/\.[^.]+$/, '') + '.' + ext;
    fs.writeFileSync(path.join(IMG_DIR, safe), buf);
    console.log(`🖼️  Asset salvo: img/${safe}`);
    res.json({ url: `/img/${safe}`, name: safe });
  } catch (err) {
    console.error('Asset upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Delete permanent asset ─────────────────────────────────────────────────
app.delete('/api/assets/:fname', (req, res) => {
  const safe = path.basename(req.params.fname);
  const p    = path.join(IMG_DIR, safe);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

// ── PDF Generation ─────────────────────────────────────────────────────────
app.post('/api/pdf', async (req, res) => {
  const data = req.body;

  // ── Logo embed ──────────────────────────────────────────────────────────
  let logoBase64 = '';
  const logoPath = path.join(__dirname, 'logo.png');
  if (fs.existsSync(logoPath)) {
    logoBase64 = fs.readFileSync(logoPath).toString('base64');
  }

  console.log(`📋 Imagens recebidas: ${(data.images||[]).length}`);
  (data.images||[]).forEach((img,i)=>console.log(`   [${i}] caption="${img.caption?.substring(0,60)}"`));

  // Report images are base64 dataUrls — pass through directly.
  const resolvedImages = (data.images || []).map(img => img);

  // Same for client cover and technician signature
  function resolveDataOrFile(val) {
    if (!val) return val;
    if (val.startsWith('data:')) return val;
    // /img/file.png  (asset) or /img/uploads/file.png (report upload)
    if (val.startsWith('/img/')) {
      const rel = val.replace('/img/', '');
      const abs = path.join(IMG_DIR, rel);
      if (fs.existsSync(abs)) {
        const buf = fs.readFileSync(abs);
        const ext = path.extname(abs).slice(1).replace('jpg','jpeg');
        return `data:image/${ext};base64,${buf.toString('base64')}`;
      }
    }
    return val;
  }

  const resolvedData = {
    ...data,
    images: resolvedImages,
    client: data.client ? {
      ...data.client,
      cover: resolveDataOrFile(data.client.cover),
    } : data.client,
    techs: (data.techs || []).map(t => ({
      ...t,
      sign: resolveDataOrFile(t.sign),
    })),
  };

  // ── Inject into template ────────────────────────────────────────────────
  const templatePath = path.join(__dirname, 'template.html');
  let html = fs.readFileSync(templatePath, 'utf8');
  html = html.replace(
    '/*INJECT_DATA*/',
    `window.REPORT_DATA = ${JSON.stringify(resolvedData)};
     window.LOGO_B64    = "data:image/png;base64,${logoBase64}";`
  );

  // ── Puppeteer ───────────────────────────────────────────────────────────
  let browser;
  try {
    console.log('🖨️  Iniciando Puppeteer...');

    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none',
      ],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);

    await page.setContent(html, { waitUntil: ['load', 'networkidle0'], timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 600));

    console.log('📄 Gerando PDF...');

    const pdfRaw = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      timeout: 60000,
    });

    await browser.close();
    browser = null;

    const pdfBuffer = Buffer.isBuffer(pdfRaw) ? pdfRaw : Buffer.from(pdfRaw);

    // Sanity check
    if (pdfBuffer.slice(0, 4).toString('ascii') !== '%PDF') {
      throw new Error('Buffer gerado não é um PDF válido');
    }

    console.log(`✅ PDF gerado — ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    // ── Filename ────────────────────────────────────────────────────────
    const clientName = (data.client?.obra || 'CLIENTE')
      .toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '-').replace(/[^A-Z0-9\-]/g, '');
    const relNum    = (data.relNum || 'R01').replace(/\s+/g, '');
    const dateParts = (data.date || '').split('-');
    const dateStr   = dateParts.length === 3
      ? `${dateParts[2]}_${dateParts[1]}_${dateParts[0]}` : '00_00_0000';
    const filename  = `REL-HVAC-${clientName}-${relNum}_${dateStr}.pdf`;

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Length':       pdfBuffer.length,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-cache',
    });
    res.end(pdfBuffer);

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ PDF error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Start server with graceful port-in-use handling ───────────────────────
function startServer(port) {
  const server = app.listen(port);

  server.on('listening', () => {
    console.log(`\n✅  Trend Controls — Relatórios HVAC`);
    console.log(`   Acesse: http://localhost:${port}`);
    console.log(`   Imagens salvas em: ${IMG_DIR}`);
    console.log(`\n   Para encerrar: Ctrl+C\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`\n⚠️  Porta ${port} em uso. Tentando porta ${port + 1}...`);
      server.close();
      startServer(port + 1);
    } else {
      console.error('Erro ao iniciar servidor:', err.message);
      process.exit(1);
    }
  });
}

startServer(PORT);



// ─── PDF Generation ──────────────────────────────────────────────────────────
app.post('/api/pdf', async (req, res) => {
  const data = req.body;

  // ── Logo embed ──────────────────────────────────────────────────────────────
  let logoBase64 = '';
  const logoPath = path.join(__dirname, 'logo.png');
  if (fs.existsSync(logoPath)) {
    logoBase64 = fs.readFileSync(logoPath).toString('base64');
  }

  // ── Inject data into template ───────────────────────────────────────────────
  const templatePath = path.join(__dirname, 'template.html');
  let html = fs.readFileSync(templatePath, 'utf8');
  html = html.replace(
    '/*INJECT_DATA*/',
    `window.REPORT_DATA = ${JSON.stringify(data)};
     window.LOGO_B64    = "data:image/png;base64,${logoBase64}";`
  );

  // ── Launch Puppeteer ────────────────────────────────────────────────────────
  let browser;
  try {
    console.log('🖨️  Iniciando Puppeteer...');

    browser = await puppeteer.launch({
      headless: true,           // 'new' foi removido na v22+, use true
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--font-render-hinting=none',
      ],
    });

    const page = await browser.newPage();

    // Aumentar timeout para páginas com imagens grandes
    page.setDefaultNavigationTimeout(60000);

    // Carregar HTML diretamente (sem URL — evita problemas de CORS no Windows)
    await page.setContent(html, { waitUntil: ['load', 'networkidle0'], timeout: 60000 });

    // Aguardar fontes e imagens (base64 não precisa de rede, mas o render leva tempo)
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 600));

    console.log('📄 Gerando PDF...');

    const pdfUint8 = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      timeout: 60000,
    });

    await browser.close();
    browser = null;

    // pdfUint8 pode ser Uint8Array ou Buffer dependendo da versão — normalizar
    const pdfBuffer = Buffer.isBuffer(pdfUint8)
      ? pdfUint8
      : Buffer.from(pdfUint8);

    // Verificar que é um PDF válido (começa com %PDF)
    const header = pdfBuffer.slice(0, 4).toString('ascii');
    if (header !== '%PDF') {
      throw new Error(`Buffer inválido — header: "${header}" (esperado "%PDF")`);
    }

    console.log(`✅ PDF gerado — ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    // ── Build filename ────────────────────────────────────────────────────────
    const clientName = (data.client?.obra || 'CLIENTE')
      .toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '-').replace(/[^A-Z0-9\-]/g, '');
    const relNum    = (data.relNum || 'R01').replace(/\s+/g, '');
    const dateParts = (data.date || '').split('-');
    const dateStr   = dateParts.length === 3
      ? `${dateParts[2]}_${dateParts[1]}_${dateParts[0]}`
      : '00_00_0000';
    const filename  = `REL-HVAC-${clientName}-${relNum}_${dateStr}.pdf`;

    // ── Send ──────────────────────────────────────────────────────────────────
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Length':      pdfBuffer.length,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-cache',
    });
    res.end(pdfBuffer);   // usar .end() em vez de .send() garante envio binário puro

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ PDF error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});