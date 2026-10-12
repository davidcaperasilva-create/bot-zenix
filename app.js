const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const xlsx = require('xlsx');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });

// Inicializar cliente de Gemini AI usando la variable de entorno
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Persistencia de datos local
const DB_FILE = './db_prospectos.json';
const CHATS_FILE = './db_chats.json';

let prospectos = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : [];
let historialChats = fs.existsSync(CHATS_FILE) ? JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')) : {};

function guardarBD() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(prospectos, null, 2));
        fs.writeFileSync(CHATS_FILE, JSON.stringify(historialChats, null, 2));
    } catch (e) {
        console.error('Error guardando archivos JSON local:', e);
    }
}

// Configuración de Puppeteer optimizada para servidores Linux (Render/Railway)
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

let qrActual = null;
let estadoSesion = 'Desconectado';

// Evento al generar un nuevo QR
client.on('qr', async (qr) => {
    console.log('🔄 Nuevo código QR generado. Transmitiendo al Dashboard...');
    estadoSesion = 'Esperando escaneo';
    try {
        qrActual = await QRCode.toDataURL(qr);
        io.emit('qr', qrActual);
        io.emit('estado', estadoSesion);
    } catch (e) {
        console.error('Error convirtiendo QR a imagen DataURL:', e);
    }
});

// Evento al conectar la sesión de WhatsApp
client.on('ready', () => {
    console.log('✅ Cliente de WhatsApp vinculado y activo.');
    estadoSesion = 'Conectado';
    qrActual = null;
    io.emit('estado', estadoSesion);
    io.emit('qr_resuelto');
});

// Evento al recibir o interceptar mensajes entrantes
client.on('message', async (msg) => {
    if (msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter')) return;

    const numero = msg.from.replace('@c.us', '');
    const textoCliente = msg.body;

    // Registrar mensaje del cliente
    if (!historialChats[numero]) historialChats[numero] = [];
    const msgEntrante = { emisor: 'cliente', texto: textoCliente, hora: new Date().toLocaleTimeString() };
    historialChats[numero].push(msgEntrante);

    // Actualizar o crear registro en prospectos
    let prospecto = prospectos.find(p => p.telefono == numero || p.telefono.endsWith(numero));
    if (!prospecto) {
        prospecto = { empresa: 'Cliente WhatsApp', telefono: numero, estado: 'Respondió', ultimoMensaje: textoCliente };
        prospectos.push(prospecto);
    } else {
        prospecto.estado = 'Respondió';
        prospecto.ultimoMensaje = textoCliente;
    }
    guardarBD();

    // Notificar al Dashboard vía WebSockets
    io.emit('nuevo_mensaje', { telefono: numero, mensaje: msgEntrante, prospectos });

    // Generar respuesta con IA de Gemini
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Eres el asistente virtual comercial de Zenix, software POS y facturación electrónica. El cliente dijo: "${textoCliente}". Responde conciso, comercial y amable para agendar una demo.`
        });

        const textoBot = response.text;
        await client.sendMessage(msg.from, textoBot);

        const msgBot = { emisor: 'bot', texto: textoBot, hora: new Date().toLocaleTimeString() };
        historialChats[numero].push(msgBot);
        guardarBD();

        io.emit('nuevo_mensaje', { telefono: numero, mensaje: msgBot, prospectos });
    } catch (err) {
        console.error('Error respondiendo con Gemini AI:', err);
    }
});

// Conexión inicial de clientes WebSockets en la página Web
io.on('connection', (socket) => {
    socket.emit('estado', estadoSesion);
    if (qrActual) socket.emit('qr', qrActual);
    socket.emit('cargar_chats', { prospectos, historialChats });
});

// Endpoints REST de la API
app.get('/api/prospectos', (req, res) => res.json(prospectos));
app.get('/api/chats/:telefono', (req, res) => {
    const chat = historialChats[req.params.telefono] || [];
    res.json(chat);
});

// Carga masiva de prospectos vía Excel
app.post('/api/cargar-excel', upload.single('archivo'), (req, res) => {
    try {
        const workbook = xlsx.readFile(req.file.path);
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        rows.forEach(row => {
            let tel = String(row.Telefono || row.telefono || row.Celular || '').replace(/\D/g, '');
            if (tel && !prospectos.some(p => p.telefono === tel)) {
                prospectos.push({ 
                    empresa: row.Empresa || row.empresa || row.Nombre || 'Empresa', 
                    telefono: tel, 
                    estado: 'Pendiente', 
                    ultimoMensaje: '-' 
                });
            }
        });
        guardarBD();
        fs.unlinkSync(req.file.path);
        io.emit('actualizar_lista', prospectos);
        res.json({ success: true, total: prospectos.length });
    } catch (e) {
        res.status(500).json({ error: 'Error al procesar el archivo Excel' });
    }
});

// Webhook para Calendly
app.post('/webhook-calendly', (req, res) => {
    const data = req.body;
    if (data && data.payload && data.payload.invitee) {
        console.log(`📅 Nueva demo agendada por: ${data.payload.invitee.email}`);
    }
    res.sendStatus(200);
});

// Iniciar servidor HTTP
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor y Dashboard Admin activos en puerto ${PORT}`);
    client.initialize();
});