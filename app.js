const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const xlsx = require('xlsx');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

// Inicializar cliente Gemini con variable de entorno
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Archivo de persistencia de datos local
const DB_FILE = './db_prospectos.json';
let prospectos = [];

if (fs.existsSync(DB_FILE)) {
    try {
        prospectos = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        prospectos = [];
    }
}

function guardarBD() {
    fs.writeFileSync(DB_FILE, JSON.stringify(prospectos, null, 2));
}

// Configuración de Puppeteer optimizada para Render
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('\n--- ESCANEA ESTE CÓDIGO QR DESDE TU WHATSAPP ---');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Cliente de WhatsApp vinculado y listo.');
});

// Evento al recibir mensajes entrantes
client.on('message', async (msg) => {
    if (msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter')) return;

    const numero = msg.from.replace('@c.us', '');
    console.log(`📩 Mensaje recibido de ${numero}: ${msg.body}`);

    let prospecto = prospectos.find(p => p.telefono == numero || p.telefono.endsWith(numero));

    if (!prospecto) {
        prospecto = { empresa: 'Cliente WhatsApp', telefono: numero, estado: 'Respondió', ultimoMensaje: msg.body };
        prospectos.push(prospecto);
    } else {
        prospecto.estado = 'Respondió';
        prospecto.ultimoMensaje = msg.body;
    }
    guardarBD();

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Eres el asistente virtual comercial de Zenix, un software POS y de facturación electrónica. 
            El cliente envió: "${msg.body}". 
            Responde de forma concisa, cordial, vendedora y comercial animando a agendar una demostración gratuita.`
        });

        await client.sendMessage(msg.from, response.text);
    } catch (err) {
        console.error('Error al responder con Gemini AI:', err);
        try {
            await client.sendMessage(msg.from, "¡Hola! Gracias por comunicarte con Zenix. En un momento un asesor comercial continuará con tu solicitud.");
        } catch (e) {
            console.error('Error al enviar mensaje de respaldo:', e);
        }
    }
});

// Rutas de la API para el Dashboard Admin
app.get('/api/prospectos', (req, res) => {
    res.json(prospectos);
});

app.post('/api/cargar-excel', upload.single('archivo'), (req, res) => {
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        rows.forEach(row => {
            const empresa = row.Empresa || row.empresa || row.Nombre || 'Empresa';
            let telefono = String(row.Telefono || row.telefono || row.Celular || '');
            telefono = telefono.replace(/\D/g, '');

            if (telefono && !prospectos.some(p => p.telefono === telefono)) {
                prospectos.push({
                    empresa,
                    telefono,
                    estado: 'Pendiente',
                    ultimoMensaje: '-'
                });
            }
        });

        guardarBD();
        fs.unlinkSync(req.file.path);
        res.json({ success: true, total: prospectos.length });
    } catch (error) {
        res.status(500).json({ error: 'Error al procesar el archivo Excel' });
    }
});

// Webhook para integración con Calendly
app.post('/webhook-calendly', (req, res) => {
    const data = req.body;
    if (data && data.payload && data.payload.invitee) {
        const email = data.payload.invitee.email;
        console.log(`📅 Nueva demo agendada en Calendly por: ${email}`);
    }
    res.sendStatus(200);
});

// Inicializar el puerto del servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Dashboard Admin e Infraestructura corriendo en el puerto ${PORT}`);
    client.initialize();
});