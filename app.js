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

// Inicializar cliente Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Persistencia de datos
const DB_FILE = './db_prospectos.json';
const CHATS_FILE = './db_chats.json';

let prospectos = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : [];
let historialChats = fs.existsSync(CHATS_FILE) ? JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')) : {};

function guardarBD() {
    fs.writeFileSync(DB_FILE, JSON.stringify(prospectos, null, 2));
    fs.writeFileSync(CHATS_FILE, JSON.stringify(historialChats, null, 2));
}

// Configuración de Puppeteer para Render
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

client.on('qr', async (qr) => {
    console.log('🔄 Nuevo código QR generado.');
    estadoSesion = 'Esperando escaneo';
    qrActual = await QRCode.toDataURL(qr);
    io.emit('qr', qrActual);
    io.emit('estado', estadoSesion);
});

client.on('ready', () => {
    console.log('✅ WhatsApp vinculado correctamente.');
    estadoSesion = 'Conectado';
    qrActual = null;
    io.emit('estado', estadoSesion);
    io.emit('qr_resuelto');
});

client.on('message', async (msg) => {
    if (msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter')) return;

    const numero = msg.from.replace('@c.us', '');
    const textoCliente = msg.body;

    // Guardar chat
    if (!historialChats[numero]) historialChats[numero] = [];
    const msgEntrante = { emisor: 'cliente', texto: textoCliente, hora: new Date().toLocaleTimeString() };
    historialChats[numero].push(msgEntrante);

    // Actualizar prospecto
    let prospecto = prospectos.find(p => p.telefono == numero || p.telefono.endsWith(numero));
    if (!prospecto) {
        prospecto = { empresa: 'Cliente WhatsApp', telefono: numero, estado: 'Respondió', ultimoMensaje: textoCliente };
        prospectos.push(prospecto);
    } else {
        prospecto.estado = 'Respondió';
        prospecto.ultimoMensaje = textoCliente;
    }
    guardarBD();

    // Notificar al Dashboard en tiempo real
    io.emit('nuevo_mensaje', { telefono: numero, mensaje: msgEntrante, prospectos });

    // Respuesta con IA
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
        console.error('Error Gemini AI:', err);
    }
});

// Eventos de conexión WebSocket con la web
io.on('connection', (socket) => {
    socket.emit('estado', estadoSesion);
    if (qrActual) socket.emit('qr', qrActual);
    socket.emit('cargar_chats', { prospectos, historialChats });
});

// API Endpoints
app.get('/api/prospectos', (req, res) => res.json(prospectos));
app.get('/api/chats/:telefono', (req, res) => {
    const chat = historialChats[req.params.telefono] || [];
    res.json(chat);
});

app.post('/api/cargar-excel', upload.single('archivo'), (req, res) => {
    try {
        const workbook = xlsx.readFile(req.file.path);
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        rows.forEach(row => {
            let tel = String(row.Telefono || row.telefono || row.Celular || '').replace(/\D/g, '');
            if (tel && !prospectos.some(p => p.telefono === tel)) {
                prospectos.push({ empresa: row.Empresa || row.Nombre || 'Empresa', telefono: tel, estado: 'Pendiente', ultimoMensaje: '-' });
            }
        });
        guardarBD();
        fs.unlinkSync(req.file.path);
        io.emit('actualizar_lista', prospectos);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Error procesando Excel' });
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    client.initialize();
});