const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const xlsx = require('xlsx');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

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
    systemPrompt: `Eres Camila, asesora comercial humana de Zenix POS y Facturación Electrónica DIAN (zenixfacturacionelectronica.online). Tu objetivo es conversar de manera super natural, amable y cercana por WhatsApp como una persona real para agendar una prueba gratis o demo del sistema POS.`,
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

// Función para purgar carpetas de autenticación atascadas
function purgarAutenticacion() {
    const carpetas = ['./.wwebjs_auth', './.wwebjs_cache'];
    carpetas.forEach(dir => {
        if (fs.existsSync(dir)) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
                console.log(`🧹 Carpeta de sesión eliminada: ${dir}`);
            } catch (err) {
                console.error(`Error borrando ${dir}:`, err.message);
            }
        }
    });
}

const UA_WINDOWS_STABLE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function crearClienteWhatsApp() {
    return new Client({
        authStrategy: new LocalAuth({ clientId: "zenix-win-session" }),
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        authTimeoutMs: 120000,
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        },
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
                '--disable-gpu',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                `--user-agent=${UA_WINDOWS_STABLE}`
            ]
        }
    });
}

let client = crearClienteWhatsApp();
let qrActual = null;
let estadoSesion = 'Desconectado';

function registrarEventosCliente(clienteInstancia) {
    clienteInstancia.on('qr', async (qr) => {
        console.log('🔄 Nuevo Código QR generado.');
        estadoSesion = 'Esperando escaneo';

        try {
            if (clienteInstancia.pupPage) {
                await clienteInstancia.pupPage.setUserAgent(UA_WINDOWS_STABLE);
            }
        } catch (e) {}

        try {
            qrActual = await QRCode.toDataURL(qr);
            io.emit('qr', qrActual);
            io.emit('estado', estadoSesion);
        } catch (e) {
            console.error('Error QR:', e);
        }
    });

    clienteInstancia.on('authenticated', () => {
        console.log('🔑 Sesión autenticada.');
        estadoSesion = 'Conectado';
        qrActual = null;
        io.emit('estado', estadoSesion);
        io.emit('qr_resuelto');
    });

    clienteInstancia.on('ready', () => {
        console.log('✅ Cliente WhatsApp LISTO.');
        estadoSesion = 'Conectado';
        qrActual = null;
        io.emit('estado', estadoSesion);
        io.emit('qr_resuelto');
    });

    clienteInstancia.on('auth_failure', (msg) => {
        console.error('❌ Falla autenticación:', msg);
        estadoSesion = 'Desconectado';
        qrActual = null;
        io.emit('estado', estadoSesion);
    });

    clienteInstancia.on('disconnected', (reason) => {
        console.log('⚠️ WhatsApp desconectado:', reason);
        estadoSesion = 'Desconectado';
        qrActual = null;
        io.emit('estado', estadoSesion);
    });

    clienteInstancia.on('message', async (msg) => {
        if (msg.from.endsWith('@g.us') || msg.from.endsWith('@newsletter') || msg.from.includes('status@broadcast')) return;

        const numero = msg.from.replace('@c.us', '');
        const textoCliente = msg.body;

        console.log(`📩 Mensaje de ${numero}: "${textoCliente}"`);

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
                await new Promise(r => setTimeout(r, 2000));

                await clienteInstancia.sendMessage(msg.from, textoBot);
                console.log(`🤖 Respuesta enviada a ${numero}`);

                const msgBot = { emisor: 'bot', texto: textoBot, hora: new Date().toLocaleTimeString() };
                historialChats[numero].push(msgBot);
                guardarBD();

                io.emit('nuevo_mensaje', { telefono: numero, mensaje: msgBot, prospectos, metricas: calcularMetricas() });
            } catch (err) {
                console.error('❌ Error Gemini AI:', err.message || err);
            }
        }
    });
}

registrarEventosCliente(client);

async function iniciarProspeccionMasiva() {
    if (prospectandoEnProgreso) return;
    if (!client.info || !client.info.wid) {
        console.log('⏳ Prospección en espera: No hay WhatsApp vinculado.');
        return;
    }

    prospectandoEnProgreso = true;
    console.log('🚀 Iniciando prospección masiva progresiva...');

    for (let p of prospectos) {
        if (p.estado === 'Pendiente' || p.estado === 'Error') {
            if (enviosHoy >= (config.limiteDiario || 100)) {
                console.log('🛑 Límite diario de envíos alcanzado.');
                break;
            }

            try {
                let telLimpio = String(p.telefono).replace(/\D/g, '');
                if (!telLimpio.startsWith('57') && telLimpio.length === 10) telLimpio = '57' + telLimpio;

                let chatId = telLimpio + '@c.us';

                let mensajeInicial = config.mensajePlantilla || '¡Hola {Nombre}! Conoce Zenix POS.';
                mensajeInicial = mensajeInicial.replace(/\{Nombre\}/g, p.empresa || 'Cliente');
                mensajeInicial = mensajeInicial.replace(/\{Empresa\}/g, p.empresa || 'su negocio');

                console.log(`📤 Enviando a ${p.empresa} (${chatId})...`);

                await client.sendMessage(chatId, mensajeInicial);
                console.log(`✅ Enviado a ${p.empresa}`);

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

                console.log(`⏱️ Pausa de ${Math.round(delayMs/1000)}s antes del próximo envío...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            } catch (e) {
                console.error(`❌ Error enviando a ${p.telefono}:`, e.message || e);
                p.estado = 'Error';
                guardarBD();
                io.emit('actualizar_lista', { prospectos, metricas: calcularMetricas() });
            }
        }
    }
    prospectandoEnProgreso = false;
    console.log('🏁 Prospección completada.');
}

function calcularMetricas() {
    const total = prospectos.length;
    const contactados = prospectos.filter(p => p.estado === 'Contactado' || p.estado === 'Respondió').length;
    const respondieron = prospectos.filter(p => p.estado === 'Respondió').length;
    const pendientes = prospectos.filter(p => p.estado === 'Pendiente' || p.estado === 'Error').length;
    return { total, contactados, respondieron, pendientes, enviosHoy, limiteDiario: config.limiteDiario || 100 };
}

io.on('connection', (socket) => {
    const estaConectadoReal = Boolean(client.info && client.info.wid);
    
    if (estaConectadoReal) {
        estadoSesion = 'Conectado';
        socket.emit('estado', estadoSesion);
        socket.emit('qr_resuelto');
    } else {
        estadoSesion = qrActual ? 'Esperando escaneo' : 'Desconectado';
        socket.emit('estado', estadoSesion);
        if (qrActual) socket.emit('qr', qrActual);
    }

    socket.emit('cargar_chats', { prospectos, historialChats, config, metricas: calcularMetricas() });
});

app.get('/api/prospectos', (req, res) => res.json(prospectos));
app.get('/api/config', (req, res) => res.json(config));
app.get('/api/metricas', (req, res) => res.json(calcularMetricas()));

// Endpoint para purgar completamente la sesión física en disco y reiniciar el cliente
app.post('/api/reset-sesion', async (req, res) => {
    try {
        console.log('🧹 PURGANDO SESIÓN Y SESIONES RESIDUALES DE DISCO...');
        estadoSesion = 'Desconectado';
        qrActual = null;
        io.emit('estado', estadoSesion);

        try {
            await client.destroy();
        } catch (eDestroy) {}

        purgarAutenticacion();

        client = crearClienteWhatsApp();
        registrarEventosCliente(client);
        client.initialize();

        res.json({ success: true, message: 'Sesión purgada en disco. Generando nuevo QR en Windows...' });
    } catch (e) {
        console.error('Error reset:', e);
        res.status(500).json({ error: 'Error purgando sesión' });
    }
});

app.post('/api/iniciar-prospeccion', (req, res) => {
    iniciarProspeccionMasiva();
    res.json({ success: true, message: 'Prospección iniciada' });
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
        
        let chatId = telLimpio + '@c.us';

        console.log(`📤 Envío manual a ${chatId}: "${texto}"`);
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
        console.error("❌ Error envío manual:", e.message || e);
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
        
        res.json({ success: true, agregados, total: prospectos.length });
    } catch (e) {
        console.error("Error Excel:", e);
        res.status(500).json({ error: 'Error procesando Excel' });
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor Zenix escuchando en puerto ${PORT}`);
    client.initialize();
});
