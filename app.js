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
const CONFIG_FILE = './db_config.json';

let prospectos = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : [];
let historialChats = fs.existsSync(CHATS_FILE) ? JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')) : {};
let config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {
    systemPrompt: `Eres Camila, asesora comercial humana de Zenix POS y Facturación Electrónica DIAN (zenixfacturacionelectronica.online). 

Tu objetivo es conversar de manera super natural, amable y cercana por WhatsApp como una persona real para agendar una prueba gratis o demo del sistema POS.

REGLAS DE COMPORTAMIENTO HUMANO:
1. Habla en primera persona ("Hola, soy Camila de Zenix", "Te cuento...", "Si quieres te ayudo a activarlo").
2. Escribe mensajes CORTOS y fluidos (1 o 2 frases por mensaje máximo). NUNCA mandes viñetas rígidas, listas largas ni bloques enormes de texto.
3. Sé empática y natural. Usa emoticones cotidianos (😊, 👋, 💻, 👍) sin exagerar.
4. NUNCA suenes como bot ni digas "En qué puedo asistirte hoy" o "Como modelo de inteligencia artificial".
5. Enfócate en resolver lo que pregunta el cliente y cierra SIEMPRE con una pregunta sencilla para continuar la charla (ej. "¿Tu negocio es un restaurante o una tienda?", "¿Qué programa usan actualmente para facturar?").

CONOCIMIENTO DE PRODUCTO:
- Zenix integra Punto de Venta (POS), inventario, caja chica, cartera y facturación electrónica DIAN.
- Sirve para restaurantes, minimarkets, ferreterías, droguerías, tiendas de ropa, etc.
- Funciona desde computador, tablet o celular.
- Ofrecemos 14 días de prueba totalmente gratis sin compromiso.`,
    mensajePlantilla: '¡Hola {Nombre}! 👋 Me comunico de Zenix POS y Facturación Electrónica. Vemos que administras {Empresa}. ¿Te gustaría probar gratis durante 14 días nuestro sistema POS e impulsar tus ventas?',
    delayMin: 15,
    delayMax: 35,
    limiteDiario: 100
};

let prospectandoEnProgreso = false;
let enviosHoy = 0;

function guardarBD() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(prospectos, null, 2));
        fs.writeFileSync(CHATS_FILE, JSON.stringify(historialChats, null, 2));
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Error guardando archivos BD:', e);
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
    console.log('🔄 QR Generado.');
    estadoSesion = 'Esperando escaneo';
    try {
        qrActual = await QRCode.toDataURL(qr);
        io.emit('qr', qrActual);
        io.emit('estado', estadoSesion);
    } catch (e) {
        console.error('Error QR:', e);
    }
});

client.on('authenticated', () => {
    estadoSesion = 'Conectado';
    qrActual = null;
    io.emit('estado', estadoSesion);
    io.emit('qr_resuelto');
});

client.on('ready', () => {
    console.log('✅ WhatsApp Vinculado y Activo.');
    estadoSesion = 'Conectado';
    qrActual = null;
    io.emit('estado', estadoSesion);
    io.emit('qr_resuelto');
    
    iniciarProspeccionMasiva();
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
        prospecto = { empresa: 'Cliente WhatsApp', telefono: numero, estado: 'Respondió', ultimoMensaje: textoCliente, iaActiva: true };
        prospectos.push(prospecto);
    } else {
        prospecto.estado = 'Respondió';
        prospecto.ultimoMensaje = textoCliente;
        if (prospecto.iaActiva === undefined) prospecto.iaActiva = true;
    }
    guardarBD();

    io.emit('nuevo_mensaje', { telefono: numero, mensaje: msgEntrante, prospectos, metricas: calcularMetricas() });

    if (prospecto.iaActiva !== false) {
        try {
            const promptCompleto = `${config.systemPrompt}\n\nEl cliente dijo: "${textoCliente}".`;
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: promptCompleto
            });

            const textoBot = response.text;
            await client.sendMessage(msg.from, textoBot);

            const msgBot = { emisor: 'bot', texto: textoBot, hora: new Date().toLocaleTimeString() };
            historialChats[numero].push(msgBot);
            guardarBD();

            io.emit('nuevo_mensaje', { telefono: numero, mensaje: msgBot, prospectos, metricas: calcularMetricas() });
        } catch (err) {
            console.error('Error Gemini AI:', err);
        }
    }
});

async function iniciarProspeccionMasiva() {
    if (prospectandoEnProgreso) return;
    if (estadoSesion !== 'Conectado' && (!client.info || !client.info.wid)) {
        console.log('⏳ Esperando que WhatsApp esté completamente conectado...');
        return;
    }

    prospectandoEnProgreso = true;
    console.log('🚀 Iniciando motor de prospección masiva...');

    for (let p of prospectos) {
        if (p.estado === 'Pendiente') {
            if (enviosHoy >= (config.limiteDiario || 100)) {
                console.log('⚠️ Límite diario alcanzado.');
                break;
            }

            try {
                let telLimpio = String(p.telefono).replace(/\D/g, '');
                if (!telLimpio.startsWith('57') && telLimpio.length === 10) {
                    telLimpio = '57' + telLimpio;
                }
                const chatId = telLimpio + '@c.us';

                let mensajeInicial = config.mensajePlantilla || '¡Hola {Nombre}! Conoce Zenix POS.';
                mensajeInicial = mensajeInicial.replace(/\{Nombre\}/g, p.empresa || 'Cliente');
                mensajeInicial = mensajeInicial.replace(/\{Empresa\}/g, p.empresa || 'su negocio');

                console.log(`📤 Enviando mensaje a ${p.empresa} (${chatId})...`);
                await client.sendMessage(chatId, mensajeInicial);

                p.estado = 'Contactado';
                p.ultimoMensaje = mensajeInicial;
                if (p.iaActiva === undefined) p.iaActiva = true;

                if (!historialChats[p.telefono]) historialChats[p.telefono] = [];
                historialChats[p.telefono].push({ emisor: 'bot', texto: mensajeInicial, hora: new Date().toLocaleTimeString() });

                enviosHoy++;
                guardarBD();
                io.emit('actualizar_lista', { prospectos, metricas: calcularMetricas() });

                const minMs = (config.delayMin || 15) * 1000;
                const maxMs = (config.delayMax || 35) * 1000;
                const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

                console.log(`⏱️ Pausa de ${Math.round(delayMs/1000)}s antes del siguiente envío...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            } catch (e) {
                console.error(`❌ Error enviando a ${p.telefono}:`, e);
                p.estado = 'Error';
                guardarBD();
                io.emit('actualizar_lista', { prospectos, metricas: calcularMetricas() });
            }
        }
    }
    prospectandoEnProgreso = false;
    console.log('🏁 Prospección finalizada o en espera de nuevos pendientes.');
}

function calcularMetricas() {
    const total = prospectos.length;
    const contactados = prospectos.filter(p => p.estado === 'Contactado' || p.estado === 'Respondió').length;
    const respondieron = prospectos.filter(p => p.estado === 'Respondió').length;
    const pendientes = prospectos.filter(p => p.estado === 'Pendiente').length;
    return { total, contactados, respondieron, pendientes, enviosHoy, limiteDiario: config.limiteDiario || 100 };
}

io.on('connection', (socket) => {
    if (client.info && client.info.wid) estadoSesion = 'Conectado';
    socket.emit('estado', estadoSesion);
    if (estadoSesion === 'Conectado') socket.emit('qr_resuelto');
    else if (qrActual) socket.emit('qr', qrActual);
    socket.emit('cargar_chats', { prospectos, historialChats, config, metricas: calcularMetricas() });
});

app.get('/api/prospectos', (req, res) => res.json(prospectos));
app.get('/api/config', (req, res) => res.json(config));
app.get('/api/metricas', (req, res) => res.json(calcularMetricas()));

app.post('/api/iniciar-prospeccion', (req, res) => {
    iniciarProspeccionMasiva();
    res.json({ success: true, message: 'Prospección disparada manualmente' });
});

app.post('/api/config', (req, res) => {
    const { systemPrompt, mensajePlantilla, delayMin, delayMax, limiteDiario } = req.body;
    if (systemPrompt) config.systemPrompt = systemPrompt;
    if (mensajePlantilla) config.mensajePlantilla = mensajePlantilla;
    if (delayMin) config.delayMin = parseInt(delayMin);
    if (delayMax) config.delayMax = parseInt(delayMax);
    if (limiteDiario) config.limiteDiario = parseInt(limiteDiario);
    guardarBD();
    io.emit('config_actualizada', config);
    res.json({ success: true, config });
});

app.post('/api/toggle-ia', (req, res) => {
    const { telefono, iaActiva } = req.body;
    let prospecto = prospectos.find(p => p.telefono == telefono || p.telefono.endsWith(telefono));
    if (prospecto) {
        prospecto.iaActiva = iaActiva;
        guardarBD();
        io.emit('actualizar_lista', { prospectos, metricas: calcularMetricas() });
        res.json({ success: true, iaActiva: prospecto.iaActiva });
    } else {
        res.status(404).json({ error: 'Prospecto no encontrado' });
    }
});

app.post('/api/enviar-manual', async (req, res) => {
    const { telefono, texto } = req.body;
    try {
        let telLimpio = String(telefono).replace(/\D/g, '');
        if (!telLimpio.startsWith('57') && telLimpio.length === 10) telLimpio = '57' + telLimpio;
        const chatId = telLimpio + '@c.us';

        await client.sendMessage(chatId, texto);

        const msgManual = { emisor: 'asesor', texto, hora: new Date().toLocaleTimeString() };
        if (!historialChats[telefono]) historialChats[telefono] = [];
        historialChats[telefono].push(msgManual);

        let prospecto = prospectos.find(p => p.telefono == telefono || p.telefono.endsWith(telefono));
        if (prospecto) prospecto.ultimoMensaje = texto;

        guardarBD();
        io.emit('nuevo_mensaje', { telefono, mensaje: msgManual, prospectos, metricas: calcularMetricas() });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Error enviando mensaje' });
    }
});

app.post('/api/cargar-excel', upload.single('archivo'), (req, res) => {
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        
        let agregados = 0;
        rows.forEach(row => {
            let telRaw = row.Contacto || row.contacto || row.Telefono || row.telefono || row.Celular || row.celular || row.Phone || row.phone || '';
            let tel = String(telRaw).replace(/\D/g, '');
            let emp = row.Nombre || row.nombre || row.Empresa || row.empresa || row.Cliente || row.cliente || 'Empresa';

            if (tel && !prospectos.some(p => p.telefono === tel)) {
                prospectos.push({ 
                    empresa: emp, 
                    telefono: tel, 
                    estado: 'Pendiente', 
                    ultimoMensaje: '-',
                    iaActiva: true
                });
                agregados++;
            }
        });

        guardarBD();
        fs.unlinkSync(req.file.path);
        
        io.emit('actualizar_lista', { prospectos, metricas: calcularMetricas() });
        
        setTimeout(() => {
            iniciarProspeccionMasiva();
        }, 1000);
        
        res.json({ success: true, agregados, total: prospectos.length });
    } catch (e) {
        console.error("Error Excel:", e);
        res.status(500).json({ error: 'Error procesando Excel' });
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor Zenix listo en puerto ${PORT}`);
    client.initialize();
});
