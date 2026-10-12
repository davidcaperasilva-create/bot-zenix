const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// ==========================================
// CONFIGURACIÓN INICIAL
// ==========================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY 
const LINK_CALENDLY = "https://calendly.com/zenixfacturacionelectronica/30min";
const PUERTO = process.env.PORT || 3000;
const DB_FILE = 'db_prospectos.json';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// Base de datos persistente sencilla en JSON
let dbProspectos = [];
if (fs.existsSync(DB_FILE)) {
    try {
        dbProspectos = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch (e) {
        dbProspectos = [];
    }
}

function guardarDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbProspectos, null, 2));
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('uncaughtException', (err) => console.error('Error capturado:', err.message));
process.on('unhandledRejection', (reason) => console.error('Promesa rechazada:', reason));

// ==========================================
// CONTEXTO ZENIX
// ==========================================
const CONTEXTO_ZENIX = `
Eres el asesor experto y oficial de Zenix (Facturación Electrónica y Punto de Venta en Colombia). Tu objetivo es responder preguntas de clientes, generar confianza, resolver dudas sobre el sistema y agendarlos a una demo rápida de 10 minutos por Calendly.

INFORMACIÓN COMPLETA DE ZENIX:
- ¿Qué es Zenix?: Es un sistema POS en la nube para tiendas, restaurantes, ferreterías, panaderías, fruvers, carnicerías, peluquerías y todo tipo de comercio en Colombia. Permite vender, facturar electrónicamente y controlar inventario desde cualquier computador, tablet o celular.
- Facturación Electrónica DIAN: Incluye emisión de factura electrónica con CUFE y QR, notas crédito, facturas a crédito. Acompañamos paso a paso con la habilitación DIAN y la firma digital.
- Funciones del Sistema:
  * Punto de venta rápido con lector de códigos de barras (o pantalla táctil).
  * Venta por peso/kilo/libras para fruvers y carnicerías ("Deme $5.000 de papa" o por gramos).
  * Carga masiva de productos e inventarios desde Excel.
  * Control de caja: apertura, cierre y cuadre para evitar faltantes.
  * Ventas a crédito (fiado), abonos y recordatorios de cobro por WhatsApp.
  * Cotizaciones en PDF enviables por WhatsApp/correo.
  * Envío de comprobantes y facturas electrónicas por WhatsApp al cliente.
  * Cajeros con permisos (usuarios ilimitados para tus empleados).
- Requisitos e Instalación: NO requiere instalar nada (funciona desde Google Chrome, Edge o Safari). Compatible con cualquier lector de código de barras USB/Bluetooth y cualquier impresora de tirilla (58mm o 80mm).
- Planes y Precios (Precios de Lanzamiento anuales en COP):
  1. Zenix Facturación: $250.000 / año (equivale a $20.833 al mes). Ideal para quienes solo necesitan emitir factura electrónica.
  2. Zenix POS (Más completo): $550.000 / año (equivale a $45.833 al mes). Incluye caja, inventario, kardex, proveedores, POS y Facturación Electrónica DIAN ilimitada.
- Prueba Gratis: 14 días sin tarjeta de crédito y sin compromiso.
`;

// ==========================================
// WHATSAPP EVENTS
// ==========================================
client.on('qr', (qr) => {
    console.log('\n Escanea este código QR desde tu WhatsApp:\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log(' Bot conectado exitosamente a WhatsApp Web.');
    iniciarProspeccion();
});

// ==========================================
// PROSPECCIÓN CONTROLADA
// ==========================================
async function generarSaludoPersonalizado(nombreEmpresa) {
    const prompt = CONTEXTO_ZENIX + "\n\nINSTRUCCIÓN DE PROSPECCIÓN:\nCrea un saludo comercial en frío para la empresa '" + nombreEmpresa + "'.\nReglas:\n- Máximo 3 líneas de texto.\n- Ofrece 14 días gratis de 'Zenix Facturación Electrónica y POS'.\n- Pregunta amablemente si están abiertos a ver una demo corta de 10 minutos.\n- Sé muy cordial, profesional y directo al grano.";

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
        });
        return response.text.trim();
    } catch (error) {
        return `Hola, un saludo de parte del equipo de Zenix. ¿Cómo están en ${nombreEmpresa}? Queremos regalarles 14 días gratis de Zenix POS y Facturación Electrónica para simplificar sus ventas e inventario. ¿Les interesaría ver una demo corta de 10 minutos?`;
    }
}

async function iniciarProspeccion() {
    for (let index = 0; index < dbProspectos.length; index++) {
        const p = dbProspectos[index];
        if (p.estado === 'Pendiente') {
            let telefono = String(p.telefono).replace(/[^0-9]/g, '');
            if (telefono.length === 10) telefono = `57${telefono}`;
            const chatId = `${telefono}@c.us`;

            console.log(` Prospectando a: ${p.nombre} (${telefono})...`);
            const mensaje = await generarSaludoPersonalizado(p.nombre);

            try {
                await client.sendMessage(chatId, mensaje);
                p.estado = 'Enviado';
                p.fechaEnvio = new Date().toISOString();
                guardarDB();

                const tiempoEsperaMs = Math.floor(Math.random() * (60000 - 45000 + 1)) + 45000;
                await delay(tiempoEsperaMs);
            } catch (err) {
                p.estado = 'Error';
                guardarDB();
            }
        }
    }
}

// ==========================================
// RESPUESTA INTELIGENTE EN TIEMPO REAL
// ==========================================
client.on('message', async (msg) => {
    if (msg.fromMe || msg.isGroupMsg || msg.from.includes('status') || msg.from.includes('broadcast')) return;

    const telefonoLimpio = msg.from.replace('@c.us', '');
    const textoCliente = msg.body;

    // Actualizar estado en la BD local
    let prospecto = dbProspectos.find(p => p.telefono.includes(telefonoLimpio.slice(-10)));
    if (prospecto) {
        prospecto.estado = 'Respondió';
        prospecto.ultimoMensaje = textoCliente;
        prospecto.fechaRespuesta = new Date().toISOString();
    } else {
        prospecto = {
            id: Date.now(),
            nombre: msg._data.notifyName || 'Contacto Directo',
            telefono: telefonoLimpio,
            estado: 'Respondió',
            ultimoMensaje: textoCliente,
            fechaRespuesta: new Date().toISOString()
        };
        dbProspectos.push(prospecto);
    }
    guardarDB();

    const promptRespuesta = CONTEXTO_ZENIX + "\n\nINSTRUCCIÓN DE ATENCIÓN A CLIENTES:\nEl cliente te escribió: \"" + textoCliente + "\"\n\nREGLAS DE RESPUESTA:\n1. Si el cliente tiene dudas o preguntas sobre precios o funciones, respóndele en UN PÁRRAFO CORTO basándote en la información de Zenix. Al final dile que en la demo de 10 minutos le puedes mostrar el sistema funcionando en vivo.\n2. Si el cliente acepta la demo o pide agendar, dale de inmediato el link de Calendly: " + LINK_CALENDLY + "\n3. Si dice que no le interesa, despídete cordialmente sin insistir.";

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: promptRespuesta,
        });
        await msg.reply(response.text.trim());
    } catch (error) {
        await msg.reply("¡Hola! Con gusto te explicamos todo sobre Zenix POS y Facturación Electrónica DIAN. Puedes ver el sistema en vivo agendando tu demo de 10 minutos aquí: " + LINK_CALENDLY);
    }
});

// ==========================================
// SERVIDOR ADMIN & DASHBOARD WEB
// ==========================================
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Endpoint API para métricas
app.get('/api/stats', (req, res) => {
    const total = dbProspectos.length;
    const enviados = dbProspectos.filter(p => p.estado === 'Enviado' || p.estado === 'Respondió' || p.estado === 'Agendado').length;
    const respondidos = dbProspectos.filter(p => p.estado === 'Respondió' || p.estado === 'Agendado').length;
    const agendados = dbProspectos.filter(p => p.estado === 'Agendado').length;

    res.json({ total, enviados, respondidos, agendados, prospectos: dbProspectos });
});

// Endpoint para cargar nuevo Excel desde el Dashboard
app.post('/api/upload-excel', upload.single('archivo'), (req, res) => {
    try {
        const workbook = XLSX.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        let cargados = 0;
        data.forEach(fila => {
            const nombre = fila['Nombre_Empresa'] || fila['Nombre'] || fila['Empresa'] || 'Cliente';
            let tel = String(fila['Teléfono'] || fila['Telefono'] || fila['Contacto'] || '').replace(/[^0-9]/g, '');

            if (tel.length >= 7) {
                const existe = dbProspectos.some(p => p.telefono.includes(tel.slice(-10)));
                if (!existe) {
                    dbProspectos.push({
                        id: Date.now() + Math.random(),
                        nombre: nombre,
                        telefono: tel,
                        estado: 'Pendiente',
                        ultimoMensaje: '',
                        fechaCarga: new Date().toISOString()
                    });
                    cargados++;
                }
            }
        });

        guardarDB();
        fs.unlinkSync(req.file.path);
        iniciarProspeccion();

        res.json({ success: true, cargados });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Webhook de Calendly
app.post('/webhook-calendly', async (req, res) => {
    try {
        const eventData = req.body;
        if (eventData && (eventData.event === 'invitee.created' || eventData.trigger_event === 'invitee.created')) {
            const invitee = eventData.payload ? eventData.payload.invitee : eventData.invitee;
            let telRaw = invitee.text_reminder_number || invitee.phone_number || '';
            let tel = String(telRaw).replace(/[^0-9]/g, '');

            if (tel.length >= 7) {
                let prospecto = dbProspectos.find(p => p.telefono.includes(tel.slice(-10)));
                if (prospecto) {
                    prospecto.estado = 'Agendado';
                } else {
                    dbProspectos.push({
                        id: Date.now(),
                        nombre: invitee.name || 'Cliente Calendly',
                        telefono: tel,
                        estado: 'Agendado',
                        ultimoMensaje: 'Agendó demo en Calendly',
                        fechaRespuesta: new Date().toISOString()
                    });
                }
                guardarDB();
            }
        }
        res.status(200).send('OK');
    } catch (e) {
        res.status(500).send('Error');
    }
});

app.listen(PUERTO, () => {
    console.log(` Dashboard Admin e Infraestructura corriendo en el puerto ${PUERTO}`);
});

client.initialize();