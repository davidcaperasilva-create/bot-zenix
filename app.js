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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const DB_FILE = './db_prospectos.json';
const CHATS_FILE = './db_chats.json';

let prospectos = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : [];
let historialChats = fs.existsSync(CHATS_FILE) ? JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')) : {};
let prospectandoEnProgreso = false;

function guardarBD() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(prospectos, null, 2));
        fs.writeFileSync(CHATS_FILE, JSON.stringify(historialChats, null, 2));
    } catch (e) {
        console.error('Error al guardar datos locales:', e);
    }
}

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
    try {
        qrActual = await QRCode.toDataURL(qr);
        io.emit('qr', qrActual);
        io.emit('estado', estadoSesion);
    } catch (e) {
        console.error('Error generando QR:', e);
    }
});

client.on('authenticated', () => {
    estadoSesion = 'Conectado';
    qrActual = null;
    io.emit('estado', estadoSesion);
    io.emit('qr_resuelto');
});

client.on('ready', () => {
    console.log('✅ Cliente de WhatsApp vinculado y activo.');
    estadoSesion = 'Conectado';
    qrActual = null;
    io.emit('estado', estadoSesion);
    io.emit('qr_resuelto');
});

client.on('disconnected', () => {
    estadoSesion = 'Desconectado';
    io.emit('estado', estadoSesion);
});

client.on('message', async (msg) => {
    if (msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter') || msg.from.includes('status@broadcast')) return;

    const numero = msg.from.replace('@c.us', '');
    const textoCliente = msg.body;

    if (!historialChats[numero]) historialChats[numero] = [];
    const msgEntrante = { emisor: 'cliente', texto: textoCliente, hora: new Date().toLocaleTimeString() };
    historialChats[numero].push(msgEntrante);

    let prospecto = prospectos.find(p => p.telefono == numero || p.telefono.endsWith(numero));
    if (!prospecto) {
        prospecto = { empresa: 'Cliente WhatsApp', telefono: numero, estado: 'Respondió', ultimoMensaje: textoCliente };
        prospectos.push(prospecto);
    } else {
        prospecto.estado = 'Respondió';
        prospecto.ultimoMensaje = textoCliente;
    }
    guardarBD();

    io.emit('nuevo_mensaje', { telefono: numero, mensaje: msgEntrante, prospectos });

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
        console.error('Error al responder con Gemini AI:', err);
    }
});

async function iniciarProspeccionMasiva() {
    if (prospectandoEnProgreso || estadoSesion !== 'Conectado') return;
    prospectandoEnProgreso = true;

    for (let p of prospectos) {
        if (p.estado === 'Pendiente') {
            try {
                let telLimpio = String(p.telefono).replace(/\D/g, '');
                if (!telLimpio.startsWith('57') && telLimpio.length === 10) {
                    telLimpio = '57' + telLimpio;
                }
                const chatId = telLimpio + '@c.us';

                const mensajeInicial = `¡Hola! 👋 Me comunico de Zenix POS y Facturación Electrónica. Vemos que administras ${p.empresa}. ¿Te gustaría probar gratis durante 14 días nuestro sistema POS e impulsar tus ventas?`;

                await client.sendMessage(chatId, mensajeInicial);

                p.estado = 'Contactado';
                p.ultimoMensaje = mensajeInicial;

                if (!historialChats[p.telefono]) historialChats[p.telefono] = [];
                historialChats[p.telefono].push({ emisor: 'bot', texto: mensajeInicial, hora: new Date().toLocaleTimeString() });

                guardarBD();
                io.emit('actualizar_lista', prospectos);

                await new Promise(resolve => setTimeout(resolve, 12000));
            } catch (e) {
                console.error(`Error enviando a ${p.telefono}:`, e);
                p.estado = 'Error';
                guardarBD();
            }
        }
    }
    prospectandoEnProgreso = false;
}

io.on('connection', (socket) => {
    if (client.info && client.info.wid) estadoSesion = 'Conectado';
    socket.emit('estado', estadoSesion);
    if (estadoSesion === 'Conectado') socket.emit('qr_resuelto');
    else if (qrActual) socket.emit('qr', qrActual);
    socket.emit('cargar_chats', { prospectos, historialChats });
});

app.get('/api/prospectos', (req, res) => res.json(prospectos));

app.post('/api/iniciar-prospeccion', (req, res) => {
    iniciarProspeccionMasiva();
    res.json({ success: true, message: 'Prospección iniciada' });
});

app.post('/api/cargar-excel', upload.single('archivo'), (req, res) => {
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        
        let agregados = 0;
        rows.forEach(row => {
            // Check all common field names for Phone/Contact
            let telRaw = row.Contacto || row.contacto || row.Telefono || row.telefono || row.Celular || row.celular || row.Phone || row.phone || '';
            let tel = String(telRaw).replace(/\D/g, '');

            // Check all common field names for Name/Company
            let emp = row.Nombre || row.nombre || row.Empresa || row.empresa || row.Cliente || row.cliente || 'Empresa';

            if (tel && !prospectos.some(p => p.telefono === tel)) {
                prospectos.push({ 
                    empresa: emp, 
                    telefono: tel, 
                    estado: 'Pendiente', 
                    ultimoMensaje: '-' 
                });
                agregados++;
            }
        });

        guardarBD();
        fs.unlinkSync(req.file.path);
        
        io.emit('actualizar_lista', prospectos);
        
        iniciarProspeccionMasiva();
        
        res.json({ success: true, agregados, total: prospectos.length });
    } catch (e) {
        console.error("Error procesando Excel:", e);
        res.status(500).json({ error: 'Error al procesar el archivo Excel' });
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor activo en puerto ${PORT}`);
    client.initialize();
});
