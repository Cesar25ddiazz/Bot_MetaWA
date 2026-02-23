require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const fs = require("fs-extra");
const path = require("path");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

//Función de horario
function estaFueraDeHorario() {
  const ahora = new Date();
  const utc = ahora.getTime() + ahora.getTimezoneOffset() * 60000;
  const horaMexico = new Date(utc + 3600000 * -6);

  const dia = horaMexico.getDay();
  const hora = horaMexico.getHours();
  return dia === 0 || hora >= 23 || hora < 9;
}

//Función retraso
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//Guarda al servidor Captura de errores
process.on(`unhandledRejection`, (reason, p) => {
  console.log(`Unhandled Rejection at: Promise`, p, `reason:`, reason);
});

process.on(`uncaughtException`, (err) => {
  console.log(`Caught exception: ` + err);
});

const app = express();
app.use(express.json());

// ==========================================
// 1. CONFIGURACIÓN PLUG AND PLAY
// ==========================================
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
const MI_NUMERO = process.env.MY_PERSONAL_NUMBER;
const estadosClientes = {};

//Configuración de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const BASE_PATH = path.join(__dirname, "pedidos_clientes");
fs.ensureDirSync(BASE_PATH); // Crea la carpeta principal si no existe

const dir = "./temp";
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir);
  console.log("📂 Carpeta 'temp' creada con éxito");
} else {
  console.log("✅ Carpeta 'temp' ya existe, lista para usar");
}

const PRECIOS = {
  playera_básica: 250,
  sudadera: 450,
  gorra: 180,
  taza_personalizada: 85,
  etiquetas: 260,
  mdf: "Cotización según diseño",
  personalización_extra: 150,
};

// ==========================================
// 2. FUNCIONES DE APOYO (Helpers)
// ==========================================

//Enviar Imagen con URL
async function enviarImagen(numero, urlImagen, leyenda) {
  try {
    await axios({
      method: "POST",
      url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      data: {
        messaging_product: "whatsapp",
        to: numero,
        type: "image",
        image: {
          link: urlImagen,
          caption: leyenda,
        },
      },
    });
    console.log("Imagen de tallas enviada correctamente.");
  } catch (e) {
    console.error(
      "Error al enviar imagen:",
      e,
      express.response?.data || e.message,
    );
  }
}

// Enviar mensajes de texto simples
async function enviarMensaje(numero, texto) {
  try {
    await axios({
      method: "POST",
      url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      data: {
        messaging_product: "whatsapp",
        to: numero,
        type: "text",
        text: { body: texto },
      },
    });
  } catch (e) {
    console.error("❌ Error enviarMensaje:", e.response?.data || e.message);
  }
}

//Funcion para mostrar "Escribiendo"
async function escribir(numero) {
  try {
    await axios({
      method: "POST",
      url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      data: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: numero,
        sender_action: "typing_on",
      },
    });
  } catch (e) {
    console.log("Sender action no soportada por Meta para este numero");
  }
}

// Enviar botones interactivos
async function enviarBotones(numero, textoCuerpo, listaBotones) {
  try {
    const botones = listaBotones.slice(0, 3).map((boton, i) => {
      if (typeof boton === "string") {
        return {
          type: "reply",
          reply: { id: `btn_${i}`, title: boton.substring(0, 20) },
        };
      }
      // SI EL BOTON YA ES UN OBJETO (como el que usaremos para reactivar)
      return boton;
    });
    await axios({
      method: "POST",
      url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      data: {
        messaging_product: "whatsapp",
        recipient_type: "individual", //OBLIGATORIO
        to: numero,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: textoCuerpo },
          action: { buttons: botones },
        },
      },
    });
  } catch (e) {
    console.log("✖️ DETALLE DEL ERROR:", e.response?.data?.error);
  }
}
//Enviar PDF
async function enviarPDF(numero, url, nombreArchivo) {
  try {
    await axios({
      method: "POST",
      url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      data: {
        messaging_product: "whatsapp",
        to: numero,
        type: "document",
        document: {
          link: url,
          filename: nombreArchivo,
        },
      },
    });
  } catch (error) {
    console.error(
      "Error enviado de PDF",
      error.response?.data || error.message,
    );
  }
}

async function enviarDocumento(numero, pathArchivo, nombreMostrar) {
  try {
    // 1. Leemos el archivo del disco
    const fileBuffer = fs.readFileSync(pathArchivo);

    // 2. Creamos el FormData
    const formData = new FormData();

    // 🔍 LUPA: Aquí está el truco. Creamos el Blob especificando el TYPE
    const miArchivoBlob = new Blob([fileBuffer], { type: "application/pdf" });

    // Agregamos el archivo al form.
    // WhatsApp necesita que el campo se llame "file"
    formData.append("file", miArchivoBlob, nombreMostrar);
    formData.append("messaging_product", "whatsapp");
    formData.append("type", "application/pdf");

    // 3. Subida a los servidores de Meta
    const upload = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/media`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          // No pongas Content-Type manual, Axios lo hará por ti
        },
      },
    );

    // 4. Si la subida fue exitosa, enviamos el mensaje
    if (upload.data && upload.data.id) {
      await axios.post(
        `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: numero,
          type: "document",
          document: {
            id: upload.data.id,
            filename: nombreMostrar,
          },
        },
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } },
      );
      console.log(`✅ PDF enviado exitosamente con ID: ${upload.data.id}`);
    }
  } catch (e) {
    // Log detallado para ver la respuesta de Facebook si vuelve a fallar
    console.log(
      "❌ Error enviando PDF:",
      JSON.stringify(e.response?.data || e.message),
    );
  }
}

async function guardarEnCRM(datos) {
  try {
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const doc = new GoogleSpreadsheet(
      process.env.GOOGLE_SHEET_ID,
      serviceAccountAuth,
    );
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const hoy = new Date();
    const entrega = new Date();
    entrega.setDate(hoy.getDate() + 3); //Suma 3 dias por defecto
    const origen = estaFueraDeHorario() ? "🌙 Nocturno" : "☀️ Diurno";

    await sheet.addRow({
      Fecha: hoy.toLocaleString("es-MX", {
        timeZone: "America/Mexico_City",
      }),
      Fecha: hoy.toLocaleString("es-MX", { timeZone: "America/Mexico_City" }),
      Ticket: datos.ticket,
      Cliente: datos.nombre,
      Whatsapp: `wa.me/${datos.numero}`,
      Producto: datos.categoria || "📦 GENERAL",
      Descripcion: datos.notas,
      Link_Imagen: datos.urlImagen,
      Estado_Produccion: "En Cola",
      Estado_Pago: "Pendiente",
      Total_a_Pagar: datos.precio,
      Fecha_Entrega: entrega.toLocaleDateString("es-MX"),
      Origen: origen,
    });
    console.log("Registro guardado en el CRM de Google Sheet");
  } catch (error) {
    console.error("Error al escribir en Google Sheet:", error);
  }
}

async function actualizarEstadoCRM(ticket, nuevosDatos) {
  try {
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const doc = new GoogleSpreadsheet(
      process.env.GOOGLE_SHEET_ID,
      serviceAccountAuth,
    );
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const filas = await sheet.getRows();

    //Busca la fila que coincida con el ticket
    const fila = filas.find((f) => {
      const ticketEnSheet = String(f.get("Ticket")).trim().toUpperCase();
      const ticketBuscado = String(ticket).trim().toUpperCase();

      return ticketEnSheet === ticketBuscado;
    });

    if (fila) {
      console.log(`✅ Fila encontrada. Actualizando ticket: ${ticket}`);

      // LOG DE CONTROL: Ver que datos llegan
      console.log("Datos recibidos para actualizar:", nuevosDatos);

      // 2. Aplicamos los cambios
      if (nuevosDatos.Estado_Pago) {
        fila.set("Estado_Pago", nuevosDatos.Estado_Pago);
      }
      if (nuevosDatos.Estado_Produccion) {
        fila.set("Estado_Produccion", nuevosDatos.Estado_Produccion);
      }

      // 3. GUARDADO (Crucial)
      await fila.save();
      console.log("💾 Guardado en Sheets con éxito");
      return true;
    } else {
      console.log(`⚠️ No se encontró ninguna fila con el ticket: ${ticket}`);
      return false;
    }
  } catch (error) {
    console.error("❌ Error al guardar en Sheets:", error.message);
    throw error;
  }
}

async function consultarStatusCRM(ticket) {
  try {
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const doc = new GoogleSpreadsheet(
      process.env.GOOGLE_SHEET_ID,
      serviceAccountAuth,
    );
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const filas = await sheet.getRows();

    // 1. Localizar la fila (asegurando que ambos sean strings)
    const fila = filas.find(
      (f) => String(f.get("Ticket")).trim() === String(ticket).trim(),
    );

    if (!fila) {
      console.log(`⚠️ No se encontró el ticket: ${ticket}`);
      return;
    }

    console.log(`✅ Fila encontrada. Actualizando ticket: ${ticket}`);

    // 2. Actualización Dinámica
    // Si mandas nuevosDatos.Estado_Pago, se guarda ese valor exacto
    if (nuevosDatos.Estado_Pago !== undefined) {
      fila.set("Estado_Pago", nuevosDatos.Estado_Pago);
    }

    if (nuevosDatos.Estado_Produccion !== undefined) {
      fila.set("Estado_Produccion", nuevosDatos.Estado_Produccion);
    }

    // 3. Guardado Crítico
    await fila.save();
    console.log("💾 ¡Hoja de cálculo actualizada con éxito!");
  } catch (error) {
    console.error("❌ Error al guardar en Sheets:", error.message);
  }
}

async function buscarNombreEnSheets(whatsapp) {
  try {
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const doc = new GoogleSpreadsheet(
      process.env.GOOGLE_SHEET_ID,
      serviceAccountAuth,
    );
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const filas = await sheet.getRows();

    const telCliente = whatsapp.toString().replace(/\D/g, "");

    const fila = filas.find((f) => {
      // Buscamos la columna "Whatsapp" sin importar si es minúscula o mayúscula
      const celdaWhatsapp = f.get("Whatsapp") || f.get("whatsapp") || "";
      const telSheet = celdaWhatsapp.toString().replace(/\D/g, "");

      // Comparamos los últimos 10 dígitos para ignorar prefijos como 52 o 521
      const match =
        telSheet.length >= 10 && telCliente.endsWith(telSheet.slice(-10));
      return match;
    });

    if (fila) {
      // 🔍 LUPA: Si encontramos la fila, buscamos el nombre
      // f.toObject() nos ayuda a ver todas las columnas por si fallan los nombres
      const datosFila = fila.toObject();
      const nombreEncontrado =
        datosFila["Nombre"] ||
        datosFila["nombre"] ||
        datosFila["Cliente"] ||
        datosFila["Nombre Completo"];

      if (nombreEncontrado) {
        console.log(`✅ Cliente reconocido: ${nombreEncontrado}`);
        return nombreEncontrado;
      } else {
        console.log(
          "⚠️ Se encontró el teléfono, pero la columna 'Nombre' está vacía en Sheets.",
        );
        return null;
      }
    }

    console.log(`ℹ️ El número ${telCliente} no está registrado en el Excel.`);
    return null;
  } catch (error) {
    console.error("❌ Error buscando el cliente:", error.message);
    return null;
  }
}

// Obtener la URL de descarga de una imagen desde Meta
async function procesarPedidoDetallado(
  nombreCliente,
  numeroCliente,
  imageId,
  comentario,
  ticket,
) {
  try {
    const fechaHora = new Date().toLocaleString("es-MX", {
      timeZone: "America/Mexico_City",
    });
    console.log("Iniciando proceso de imagen para:", ticket);
    if (!imageId || imageId === "Undefined") {
      throw new Error("El ID de la imagen es invalido antes de la peticion");
    }
    const responseMeta = await axios.get(
      `https://graph.facebook.com/v18.0/${imageId}`,
      { headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` } },
    );
    const urlDescarga = responseMeta.data.url;

    //Descarga de imagen como buffer
    const imagenResponse = await axios.get(urlDescarga, {
      headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` },
      responseType: "arraybuffer",
    });

    //Convertir en formato Base64 para cloudinary
    const base64Image = `data:image/jpeg;base64,${Buffer.from(imagenResponse.data).toString("base64")}`;

    //SUbir a cloudinary
    const result = await cloudinary.uploader.upload(base64Image, {
      folder: "SISTEMA_PRODUCCIÓN",
      public_id: ticket,
      resource_type: "image",
    });
    const urlPermanente = result.secure_url;
    console.log("Imagen en cloudinary:", urlPermanente);

    estadosClientes[numeroCliente] = {
      ...estadosClientes[numeroCliente], // Conservamos categoría, ticket, etc.
      urlImagen: urlPermanente, // <--- GUARDAMOS EL LINK AQUÍ
      esperandoNombre: true, // Seguimos con el flujo del nombre
    };

    // Determinar categoria para la notificacion
    let cat = "📦 GENERAL";
    const c = comentario.toLowerCase();
    if (c.includes("taza")) cat = "☕ TAZA";
    else if (c.includes("mdf")) cat = "🪵 MDF";
    else if (c.includes("etiqueta")) cat = "🏷️ ETIQUETAS";
    else if (c.includes("playera") || c.includes("sudadera")) cat = "👕 TEXTIL";
    else if (c.includes("gorra")) cat = "🧢 GORRA";

    let precioUnitario = 0;
    if (cat === "👕 TEXTIL") precioUnitario = Number(PRECIOS.playera_básica);
    else if (cat === "☕ TAZA")
      precioUnitario = Number(PRECIOS.taza_personalizada);
    else if (cat === "🏷️ ETIQUETAS") precioUnitario = Number(PRECIOS.etiquetas);
    else if (cat === "🧢 GORRA") precioUnitario = Number(PRECIOS.gorra);

    //Intenta detectar cantidad
    const numerosEnTexto = comentario.match(/\d+/);
    let cantidadDetectada = numerosEnTexto ? parseInt(numerosEnTexto[0]) : 1; //Si no se encuentra asume 1

    //Logica para etiquetas
    let totalFinal = 0;
    let precioBase = Number(PRECIOS.etiquetas);

    if (cat && cat.includes("ETIQUETAS")) {
      //Si piden 200, nos dividimos entre 100 = 2 unidades de precio
      //Usamos match.ceil para redondear hacia arriba si pide 150 cobra 2 paquetes
      totalFinal = (cantidadDetectada / 100) * precioBase;
    } else {
      totalFinal = Number(precioUnitario) * cantidadDetectada;
    }
    totalFinal = Math.round(totalFinal * 100) / 100;

    //Calculo total
    let textoPresupuesto =
      (cat && cat.includes("MDF")) || c.includes("mdf") || c.includes("madera")
        ? "Sujeto a cotización según diseño"
        : `$${totalFinal} MXN (${cantidadDetectada} pzs)`;

    //Guardar en CRM
    await guardarEnCRM({
      ticket: ticket,
      nombre: nombreCliente,
      numero: numeroCliente,
      categoria: cat,
      notas: comentario,
      urlImagen: urlPermanente,
      precio: cat.includes("MDF") ? "Cotización" : totalFinal.toString(), //Se guarda el total en la columna
    });

    //Notidicacion detallada
    const mensajeAdmin =
      `🛠️ *Orden de Producción:* 🛠️\n` +
      `-----------------------------\n` +
      `🆔 *Ticket:* \`${ticket}\`\n` +
      `👤 *Cliente:* ${nombreCliente}\n` +
      `📱 *Whatsapp:* wa.me/${numeroCliente}\n` +
      `📦 *CAT:* ${cat}\n` +
      `📝 *Notas:* ${comentario}\n` +
      `💵 *Total:* ${textoPresupuesto}\n` +
      `🖼️ *Link:* ${result.secure_url}\n` +
      `-----------------------------\n` +
      `⏰ ${fechaHora}`;
    await enviarMensaje(MI_NUMERO, mensajeAdmin);

    const despedidaElegante =
      `✅ *¡Orden registrada con éxito!*\n\n` +
      `🆔 *Ticket:* ${ticket}\n\n` +
      `💵 *Presupuesto estimado:* ${textoPresupuesto}\n\n` +
      `Estimado cliente, su solicitud ha sido enviada a nuestro taller.\n\n` +
      `Recuerda que si confirmas tu pedido te descargara un PDF con los detalles.\n\n` +
      `¿Desea realizar alguna otra consulta o prefiere hablar con un *Asesor Especializado*?`;

    await delay(1500);
    await enviarBotones(numeroCliente, despedidaElegante, [
      "Hablar con Asesor",
      "Inicio",
    ]);
  } catch (error) {
    console.error("✖️ Error en producción:", error);
  }
  return;
}

async function marcarComoLeido(messageId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      },
      {
        headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` },
      },
    );
    console.log("✅ Check azul enviado para");
  } catch (error) {
    console.error(
      "Error al marcar como leido:",
      error.response?.data || error.message,
    );
  }
}

async function generarPDFOrden(datos, pathDestino) {
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(pathDestino);

    doc.pipe(stream);

    // --- DISEÑO DE AUTORIDAD (Encabezado) ---
    doc.rect(0, 0, 612, 120).fill("#000000"); // Bloque negro sólido
    doc
      .fillColor("#ffffff")
      .fontSize(28)
      .font("Helvetica-Bold")
      .text("ORDEN DE TRABAJO", 50, 45);

    doc
      .fontSize(10)
      .font("Helvetica")
      .text(`TICKET DE SEGUIMIENTO: ${datos.ticket}`, 400, 58, {
        align: "right",
      });

    // --- CUERPO DEL DOCUMENTO ---
    doc
      .fillColor("#333333")
      .fontSize(14)
      .font("Helvetica-Bold")
      .text("INFORMACIÓN DEL PEDIDO", 50, 150);
    doc.moveTo(50, 165).lineTo(545, 165).strokeColor("#eeeeee").stroke();

    // Datos del cliente y fecha
    doc.moveDown();
    doc
      .fillColor("#000000")
      .fontSize(11)
      .font("Helvetica")
      .text(`Fecha de Emisión: ${new Date().toLocaleDateString()}`)
      .text(`ID Cliente (WhatsApp): ${datos.numero}`)
      .text(`Estado Inicial: Pendiente de Revisión`);

    // --- TABLA PROFESIONAL (Detalle del Producto) ---
    const tableTop = 250;
    doc.rect(50, tableTop, 495, 25).fill("#f6f6f6"); // Fondo gris claro para encabezado de tabla

    doc
      .fillColor("#000000")
      .font("Helvetica-Bold")
      .text("CONCEPTO / MATERIAL", 60, tableTop + 7)
      .text("CANT.", 350, tableTop + 7)
      .text("TOTAL", 480, tableTop + 7);

    const rowY = tableTop + 40;
    doc
      .font("Helvetica")
      .text(`${(datos.categoria || "PRODUCTO").toUpperCase()}`, 60, rowY)
      .text(`${datos.cantidad}`, 350, rowY)
      .text(`${datos.precioTotal}`, 480, rowY);

    doc
      .fontSize(9)
      .fillColor("#666666")
      .text(`Notas adicionales: ${datos.detalles}`, 60, rowY + 15, {
        width: 400,
      });

    // --- MARKETING Y QR (Seriedad y Modernidad) ---
    const marketingY = 450;
    doc
      .rect(50, marketingY, 495, 120)
      .strokeColor("#000000")
      .lineWidth(0.5)
      .stroke();

    doc
      .fillColor("#000000")
      .fontSize(12)
      .font("Helvetica-Bold")
      .text("NUESTRAS REDES SOCIALES", 70, marketingY + 15);
    doc
      .fontSize(10)
      .font("Helvetica")
      .text("• Instagram: @TuNegocioCreativo", 70, marketingY + 40)
      .text("• TikTok: @TuNegocioOficial", 70, marketingY + 55)
      .text("• Facebook: fb.com/TuNegocio", 70, marketingY + 70);

    // Generar QR dinámico que apunte a tu WhatsApp de atención
    const qrData = `https://wa.me/tu_numero?text=Hola, tengo una duda sobre mi ticket ${datos.ticket}`;
    const qrImage = await QRCode.toDataURL(qrData);
    doc.image(qrImage, 430, marketingY + 10, { width: 100 });

    // --- MEDIOS DE PAGO ---
    doc
      .fontSize(12)
      .font("Helvetica-Bold")
      .text("FORMAS DE PAGO ACEPTADAS", 50, 600);
    doc
      .fontSize(10)
      .font("Helvetica")
      .text("• Transferencia Interbancaria (SPEI)", 50, 620)
      .text("• Depósito en OXXO / 7-Eleven", 50, 635)
      .text("• Pago con Tarjeta (vía Mercado Pago)", 50, 650);

    if (datos.precioTotal === "Cotización") {
      doc
        .fillColor("red")
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(
          "⚠️ ATENCIÓN: Al ser una Cotización, el precio final será validado por un asesor.",
          50,
          680,
        );
    }

    // --- PIE DE PÁGINA ---
    doc
      .fillColor("#aaaaaa")
      .fontSize(8)
      .text(
        "Este es un documento oficial generado automáticamente por nuestro sistema de atención.",
        0,
        780,
        { align: "center" },
      );

    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", (err) => reject(err));
  });
}

// ==========================================
// 3. WEBHOOK (Rutas)
// ==========================================

// Validación del Webhook para Meta
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === WEBHOOK_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// Recepción de mensajes
app.post("/webhook", async (req, res) => {
  // IMPORTANTE: Responder 200 inmediatamente para evitar mensajes duplicados
  res.status(200).send("EVENT_RECEIVED");

  const body = req.body;
  const entry = body.entry?.[0]?.changes?.[0]?.value;

  if (entry && entry.messages && entry.messages[0]) {
    const msg = entry.messages[0];
    const timestampMsg = parseInt(msg.timestamp);
    const ahora = Math.floor(Date.now() / 1000);

    //Evita reintentos y mensajes viejos
    if (ahora - timestampMsg > 120) return;

    await marcarComoLeido(msg.id);
    const numeroCliente = msg.from;
    const nombreCliente = (
      entry.contacts?.[0]?.profile?.name || "Cliente"
    ).replace(/\s+/g, "_");

    // Filtro: Solo procesar si es texto, botón o imagen (ignorar estados read/delivered)
    if (
      !msg.text &&
      !msg.interactive &&
      !msg.image &&
      !msg.video &&
      !msg.audio &&
      !msg.document &&
      !msg.sticker
    )
      return;

    //Validar horario
    if (estaFueraDeHorario() && msg.type === "text") {
      const textoCliente = msg.text.body.toLowerCase();
      const horaMexico = new Date().getHours();
      if (horaMexico === 9) {
        await enviarMensaje(
          numeroCliente,
          `☀️ ¡Buenos Dias! Ya estamos de vuelta. Si mandaste un diseño anoche, un asesor lo esta revisando justo ahora. Estaremos enviándote actualizaciones en breve. 📝`,
        );
      }
      if (textoCliente.includes("hola") || textoCliente.includes("inicio")) {
        await enviarMensaje(
          numeroCliente,
          `Hola ${nombreCliente} Estamos fuera de horario  (Lunes a Viernes de 9am-8pm). Puedes enviarnos tu diseño de una vez y lo revisaremos.`,
        );
        return;
      }
    }

    try {
      // A. SI ENVÍAN UNA IMAGEN (Lo que sí procesamos)
      if (msg.type === "image") {
        const idDeLaImagen = msg.image?.id || msg.id;
        const comentarioImagen = (msg.image?.caption || "").trim();

        // 🟢 CAMBIO: Solo tomamos la categoría, si no hay, forzamos a que elija una
        const estadoActual = estadosClientes[numeroCliente] || {};

        if (!estadoActual.categoria) {
          await enviarMensaje(
            numeroCliente,
            "⚠️ Por favor, primero selecciona una categoría (Textil o Tazas) antes de enviar la imagen.",
          );
          return;
        }

        if (estadoPrevio.categoria === "TAZAS Y MDF") {
          const textoAnalizar = comentarioImagen.toLowerCase();
          //Palabras clave
          const tieneMaterial =
            textoAnalizar.includes("taza") ||
            textoAnalizar.includes("mdf") ||
            textoAnalizar.includes("madera") ||
            textoAnalizar.includes("laser") ||
            textoAnalizar.includes("grabado") ||
            textoAnalizar.includes("corte");

          if (!tieneMaterial) {
            await enviarMensaje(
              numeroCliente,
              "⚠️ *Dato importante:* Olvidaste especificar si tu diseño es para una *Taza* o para *MDF* en la descripción.\n\n" +
                "Por favor, vuelve a enviar la imagen y escribe para qué material es (ejemplo: *2 tazas* o *corte en mdf*). ✨",
            );
            return; // Detiene la generación de la orden
          }
        }

        if (!idDeLaImagen) {
          console.error("No se pudo obtener el ID de la imagen");
          return;
        }

        // --- CÁLCULO DE PRECIOS PARA EL PDF (IMPORTANTE) ---
        // Extraer cantidad
        const cantidadMatch = comentarioImagen.match(/\d+/);
        const cantidad = cantidadMatch ? parseInt(cantidadMatch[0]) : 1;
        const ticketGenerado = `PED-${Date.now()}`;

        let precioCalculado =
          estadoPrevio.categoria === "TAZAS Y MDF" &&
          comentarioImagen.toLowerCase().includes("taza")
            ? `$${cantidad * 150}`
            : "Cotización";

        const nombreRegistrado = await buscarNombreEnSheets(numeroCliente);

        //Cliente ya existe en excel
        if (nombreRegistrado) {
          console.log(`Cliente reconocido: ${nombreRegistrado}`);
          // Guardamos TODOS los datos necesarios para el PDF
          estadosClientes[numeroCliente] = {
            ...estadosClientes[numeroCliente],
            ticket: ticketGenerado,
            cantidad: cantidad,
            precioTotal: precioCalculado,
            detalles: comentarioImagen,
          };

          await procesarPedidoDetallado(
            nombreRegistrado,
            numeroCliente,
            idDeLaImagen,
            comentarioImagen,
            ticketGenerado,
          );

          const saludo = estaFueraDeHorario()
            ? `¡Hola de nuevo, ${nombreRegistrado}! 🌙 Recibimos tu diseño. Como estamos fuera de horario, lo revisaremos mañana a primera hora.\n Ticket: *${ticketGenerado}*`
            : `¡Hola ${nombreRegistrado}! ✨ Recibimos tu diseño correctamente. Generamos tu ticket: *${ticketGenerado}*.\n En un momento te confirmo los detalles.`;
          await enviarBotones(
            numeroCliente,
            saludo + "\n\n¿Deseas realizar otra acción?",
            ["Confirmar Pedido", "Cancelar Pedido", "Inicio"],
          );
          return;
        }
        //Guardamos el estado donde le cliente manda su foto y esperamos su nombre
        estadosClientes[numeroCliente] = {
          esperandoNombre: true,
          ticket: ticketGenerado,
          imageId: idDeLaImagen,
          detalles: comentarioImagen,
          categoria: estadoPrevio.categoria || "📦 GENERAL",
          cantidad: cantidad,
          precioTotal: precioCalculado,
        };

        //Confirmación inmediata del cliente
        await enviarMensaje(numeroCliente, `📸 *Imagen recibida con éxito*`);
        await delay(1000);

        //Preguntamos el nombre para el registro
        await enviarMensaje(
          numeroCliente,
          `Para registrar tu orden *${ticketGenerado}*, ¿Podrías poner tu *Nombre Completo*? ✨`,
        );
        return;
      }

      // 1. PRIMERO: Prioridad absoluta al nombre (FUERA del else if)
      if (
        msg.type === "text" &&
        estadosClientes[numeroCliente]?.esperandoNombre
      ) {
        const nombreProporcionado = msg.text.body.trim();

        if (textoEntrante.toUpperCase().includes("PED-")) {
          // No hacemos nada aquí, dejamos que el código siga hacia abajo
          // para que lo detecte la lógica de consulta de tickets.
        } else {
          const nombreProporcionado = textoEntrante;
          const datosRecuperados = estadosClientes[numeroCliente];

          estadosClientes[numeroCliente].nombre = nombreProporcionado;
          estadosClientes[numeroCliente].esperandoNombre = false;

          // Usamos "Cliente Nuevo" como nombre temporal para que Cloudinary y la notificación funcionen
          await procesarPedidoDetallado(
            nombreProporcionado,
            numeroCliente,
            datosRecuperados.imageId,
            datosRecuperados.detalles,
            datosRecuperados.ticket,
          );

          // 🔍 AQUÍ EL CAMBIO: Notificamos al Admin que ya tenemos el nombre del cliente nuevo
          const mensajeAdmin =
            `👤 *NUEVO CLIENTE REGISTRADO*\n` +
            `Nombre: ${nombreProporcionado}\n` +
            `Ticket: ${datosRecuperados.ticket}\n` +
            `WhatsApp: wa.me/${numeroCliente}`;
          await enviarMensaje(process.env.MY_PERSONAL_NUMBER, mensajeAdmin);
          await delay(1500);

          const mensajeConfirmacion =
            `¡Mucho gusto, *${nombreProporcionado}*! ✨\n\n` +
            `He registrado tu diseño para: *${datosRecuperados.categoria}*.\n` +
            `Cantidad: *${datosRecuperados.cantidad}* piezas.\n` +
            `¿Los datos son correctos para generar tu Orden en PDF?`;

          await enviarBotones(numeroCliente, mensajeConfirmacion, [
            "Confirmar Pedido",
            "Cancelar Pedido",
          ]);
          return; // ⛔ IMPORTANTE: Aquí termina el proceso para el nombre
        }
      }

      // B. SI ENVÍAN TEXTO
      else if (msg.type === "text") {
        //Limpiamos el texto del cliente
        const textoCliente = msg.text.body.toLowerCase().trim();
        const esAdmin = numeroCliente === process.env.MY_PERSONAL_NUMBER;

        if (esAdmin) {
          if (
            textoCliente.toLowerCase().startsWith("pago ") ||
            textoCliente.toLowerCase().startsWith("pagado ")
          ) {
            const ticketId = textoCliente.split(" ")[1].trim();
            console.log("Ticket detectado con éxito:", ticketId);

            // Pasamos el objeto EXACTAMENTE como lo espera la función
            await actualizarEstadoCRM(ticketId, {
              Estado_Pago: "Pagado",
              Estado_Produccion: "En Proceso",
            });

            // segundo parámetro sea un STRING
            const mensajeConfirmacion = `✅ El ticket *${ticketId}* ha sido marcado como PAGADO en el sistema.`;
            await enviarMensaje(numeroCliente, mensajeConfirmacion);
            return;
          }

          if (textoCliente.toLowerCase().startsWith("anticipo ")) {
            const ticketId = textoCliente.split(" ")[1].trim();

            await actualizarEstadoCRM(ticketId, {
              Estado_Pago: "Anticipo",
            });
            const mensajeConfirmacionA = `💰 Anticipo registrado para el ticket: *${ticketId}*`;
            await enviarMensaje(numeroCliente, mensajeConfirmacionA);
            return;
          }
        }

        //CANCELACION Y DUDA
        //Ayuda de un asesor si no sabe el cliente
        if (
          textoCliente.includes("ayuda") ||
          textoCliente.includes("duda") ||
          textoCliente.includes("no se")
        ) {
          await enviarMensaje(
            numeroCliente,
            "🫱🏼‍🫲🏼 *No te preocupes.* Si tienes duda sobre como pedir, he solicitado que un asesor humano revise el chat.\n\n En breve se comicarán contigo para que no generes un pedido incorrecto. ¡Gracias!",
          );
          await enviarMensaje(
            MI_NUMERO,
            `⚠️ *ASESORIA:* el cliente wa.me/${numeroCliente} tiene dudas sobre su pedido. `,
          );
          return;
        }

        //Cancelacion de Pedido
        if (textoCliente.startsWith("cancelar")) {
          const ticketACancelar = textoCliente
            .replace("cancelar ", "")
            .toUpperCase()
            .trim();
          if (ticketACancelar.includes("PED-")) {
            await actualizarEstadoCRM(ticketACancelar, { Estado: "Cancelado" });
            await enviarMensaje(
              numeroCliente,
              `🚫 El pedido *${ticketACancelar}* ha sido cancelado en nuestro sistema.`,
            );
          } else {
            await enviarMensaje(
              numeroCliente,
              "⚠️ Para cancelar usa el formato *Cancelar PED-12345*",
            );
          }
          return;
        }

        const groserias = [
          "puto",
          "chingada",
          "idiota",
          "estupido",
          "huevos",
          "mames",
          "pendejo",
        ];
        const detectoGroseria = groserias.some((palabra) =>
          textoCliente.includes(palabra),
        );
        if (detectoGroseria) {
          await enviarMensaje(
            numeroCliente,
            "⚠️ Mantengamos un lenguaje respetuoso para poder brindarte la mejor atencion",
          );
          await delay(1000);
          await enviarBotones(
            numeroCliente,
            "¿En que podemos ayudarte formalmente?",
            ["Inicio", "Catalogo", "Personalizar"],
          );
          return;
        }

        // Definimos una lista de palabras que activan la bienvenida
        const disparadoresBienvenida = [
          "hola",
          "buenos días",
          "buenas tardes",
          "buenas noches",
          "hey",
          "que tal",
        ];
        // Se verifica si una de estas palabras esta dentro de lo que escribio el cliente
        const quiereBienvenida = disparadoresBienvenida.some((palabra) =>
          textoCliente.includes(palabra),
        );

        if (quiereBienvenida) {
          // await escribir(numeroCliente); //El cliente ve escribiendo
          //await delay(1500);
          await enviarBotones(
            numeroCliente,
            `Hola buen dia ${nombreCliente} Bienvenido a nuestra tienda ¿En que podemos apoyarte hoy?`,
            ["Catalogo", "Precios", "Personalizar"],
          );
          return;
        }

        //Nueva respuesta de precios
        else if (
          textoCliente.includes("precios") ||
          textoCliente.includes("cuanto") ||
          textoCliente.includes("costo") ||
          textoCliente.includes("cotización")
        ) {
          //await escribir(numeroCliente); //El cliente ve escribiendo
          //await delay(1500);
          const mensajePrecios =
            `💰 *Lista de Precios actualizada* 💰\n\n` +
            `👕 *Playera personalizada:* ${PRECIOS.playera_básica}\n` +
            `🧥 *Sudadera con Diseño:* ${PRECIOS.sudadera}\n` +
            `🧢 *Gorra estampada:* ${PRECIOS.gorra}\n` +
            `✨ *Diseño extra:* ${PRECIOS.personalización_extra}\n\n` +
            `_Precios sujetos a cambios según la complejidad del diseño._\n` +
            `¿Te gustaría iniciar un pedido ahora? Presiona el botón *Personalizar*.`;

          await enviarBotones(numeroCliente, mensajePrecios, [
            "Personalizar",
            "Tallas",
          ]);
          return;
        } else if (textoCliente.includes("catalogo")) {
          //await escribir(numeroCliente); //El cliente ve escribiendo
          //await delay(1500);
          const urlPdf =
            "https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf";
          await enviarPDF(numeroCliente, urlPdf, "Catalogo_Tienda.pdf");
          await delay(3000);
          await enviarBotones(
            numeroCliente,
            "Ahi tienes el catalogo. ¿Deseas algo mas?",
            ["Tallas", "Personalizar"],
          );
          return;
        }

        const matchTicket = textoCliente.match(/PED-\d+/i);
        if (matchTicket) {
          const ticketBusqueda = matchTicket[0].toUpperCase();
          console.log("Ticket detectado con exito:", ticketBusqueda);
          const resultado = await consultarStatusCRM(ticketBusqueda);
          await enviarMensaje(numeroCliente, resultado);
          return;
        }

        console.log(`Mensaje no reconocido: ${textoCliente}`);
        const mensajeNoEntendido = `Lo siento, no logre entender tu mensaje: "${textoCliente}". 😅`;
        await enviarBotones(numeroCliente, mensajeNoEntendido, [
          "Inicio",
          "Catalogo",
          "Personalizar",
        ]);
        return;
      }

      // C. SI ENVÍAN BOTONES
      else if (msg.type === "interactive") {
        const resBtn = msg.interactive.button_reply?.title;
        const esAdmin = numeroCliente === process.env.MY_PERSONAL_NUMBER; // Verificamos que seas tú

        if (!resBtn) return; //Si por algo viene vacío, salimos para evitar errores
        console.log(`El cliente presiono: ${resBtn}`);
        let nombreRegistrado;

        switch (resBtn) {
          case "Inicio":
          case "Hola":
          case "Menu":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            await enviarBotones(
              numeroCliente,
              "🏠 *Menu Principal*\nBienvenido a nuestro centro de atención. ¿Que deseas consultar?",
              ["Catalogo", "Precios", "Personalizar"],
            );
            break;

          case "Catalogo":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            await enviarMensaje(
              numeroCliente,
              "📂 *Nuestros Catálogos*\n\n👕 *Textil:* [https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf]\n\n☕ *Tazas y Regalos:* [https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf]\n\n🪵 *Grabado y Corte MDF* [https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf]\n\n_Echa un vistazo y cuando estés listo presiona 'Personalizar'_",
            );
            await delay(2000);
            await enviarBotones(
              numeroCliente,
              "¿Te gustaría ver los precios o ya prefieres personalizar?",
              ["Precios", "Personalizar", "Inicio"],
            );
            break;
          case "Precios":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            const listaPrecios = `💰 *Lista de Nuestros Precios:*\n
            👕 Playera: ${PRECIOS.playera_básica}
            🧥 Sudadera: ${PRECIOS.sudadera}
            🧢 Gorra: ${PRECIOS.gorra}
            ☕ Taza Personalizada: ${PRECIOS.taza_personalizada}
            🏷️ Etiquetas (100 piezas): ${PRECIOS.etiquetas}
            🪵 MDF: ${PRECIOS.mdf}
            ✨ Extra: ${PRECIOS.personalización_extra}\n
            _Precios sujetos a cambios o según la complejidad_`;
            await enviarMensaje(numeroCliente, listaPrecios);
            await delay(2000);
            await enviarBotones(
              numeroCliente,
              "¿Deseas ver las tallas o empezar tu pedido?",
              ["Tallas", "Personalizar", "Inicio"],
            );
            break;

          case "Tallas":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            const urlTabla =
              "https://i.postimg.cc/13WjV0t1/Tabla-de-Tallas.jpg";
            await enviarImagen(
              numeroCliente,
              urlTabla,
              "📏 *Guía de Medidas*\nAquí tienes las tallas para nuestras prendas textiles",
            );
            await delay(3000);
            await enviarBotones(
              numeroCliente,
              "¿Deseas regresar al menu o ir a personalizar?",
              ["Inicio", "Personalizar"],
            );
            break;

          case "Personalizar":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            //Menu de los servicios
            const instrucciones =
              "🎨 *Área de Personalización*\n\n" +
              "Selecciona una Categoría para realizar un *Nuevo Pedido*.\n\n" +
              "-----------------------------\n" +
              "🔎 Si ya tienes un pedido y quieres saber su estatus escribe:\n\n" +
              "*Estatus* seguido de tu ticket (ej: *Estatus PED-1234*)\n" +
              "Puedes copiar el numero de pedido en tu orden generada.";
            await enviarBotones(numeroCliente, instrucciones, [
              "Textil",
              "Tazas y MDF",
              "Etiquetas",
            ]);
            break;

          case "Textil":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            console.log("iniciando busqueda para:", numeroCliente);
            delete estadosClientes[numeroCliente];

            estadosClientes[numeroCliente] = {
              nombre: nombreRegistrado || null,
              esperandoNombre: !nombreRegistrado,
              categoria: "TEXTIL",
            };
            await enviarMensaje(
              numeroCliente,
              "👕 *Linea textil (Playeras, Sudaderas y calcetas)*\n\n1. Envía la imagen de tu diseño.\n2. En la descripción escribe: *Talla, Color y que tipo deprenda se estampara*.",
            );
            break;

          case "Tazas y MDF":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            delete estadosClientes[numeroCliente];

            estadosClientes[numeroCliente] = {
              nombre: nombreRegistrado || null,
              esperandoNombre: !nombreRegistrado,
              categoria: "TAZAS Y MDF",
            };
            await enviarMensaje(
              numeroCliente,
              "☕*Tazas y madera MDF*🪵\n\nEnvía tu imagen o diseño especificando tus instrucciones en:\n- Taza Personalizada\n- Grabado/Corte láser en MDF",
            );
            break;

          case "Etiquetas":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            delete estadosClientes[numeroCliente];

            estadosClientes[numeroCliente] = {
              nombre: nombreRegistrado || null,
              esperandoNombre: !nombreRegistrado,
              categoria: "ETIQUETAS",
            };
            await enviarMensaje(
              numeroCliente,
              "🏷️ *Etiquetas*\nEnvía tu logo y menciona las *medidas* y la *cantidad* que necesitas.",
            );
            break;

          case "Inicio":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            await enviarBotones(
              numeroCliente,
              "Menu principal 🏠\n Selecciona una opción:",
              ["Catalogo", "Precios", "Personalizar"],
            );
            break;

          case "Hablar con Asesor":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            await enviarMensaje(
              numeroCliente,
              "🫱🏼‍🫲🏼 *Conectando con un especialista...*\n\nHe notificado a nuestro equipo especializado. En un momento uno de nuestros asesores tomara la conversación para una atención personalizada. ¡Gracias por tu paciencia.!",
            );
            //Notificación para mi
            await enviarMensaje(
              MI_NUMERO,
              `⚠️ *ATENCIÓN HUMANA:* El cliente wa.me/${numeroCliente} solicita un asesor especializado.`,
            );
            break;

          case "Nuevo Pedido":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            await enviarBotones(
              numeroCliente,
              "¡Perfecto! vamos a crear algo nuevo. ¿Que producto te interesa?",
              ["Textil", "Tazas y MDF", "Etiquetas"],
            );
            break;

          case "Cancelar Pedido":
            const ticketParaBorrar = estadosClientes[numeroCliente]?.ticket;

            if (ticketParaBorrar) {
              await actualizarEstadoCRM(ticketParaBorrar, {
                Estado_Pago: "Cancelado",
                Estado_Produccion: "Cancelado",
              });

              const alertaAdmin =
                `🚫 *PEDIDO CANCELADO POR CLIENTE*\n\n` +
                `🆔 *Ticket:* ${ticketParaBorrar}\n` +
                `👤 *Cliente:* ${numeroCliente}\n` +
                `--------------------------\n` +
                `_La fila en el Sheet se ha tachado automáticamente._`;

              // Mandamos el objeto directo para que NO le ponga "btn_0"
              await enviarBotones(process.env.MY_PERSONAL_NUMBER, alertaAdmin, [
                {
                  type: "reply",
                  reply: { id: ticketParaBorrar, title: "Reactivar Ticket" },
                },
              ]);

              await enviarMensaje(
                numeroCliente,
                `🚫 Tu pedido *${ticketParaBorrar}* ha sido cancelado exitosamente.`,
              );
              delete estadosClientes[numeroCliente];
            }
            break;

          case "Reactivar Ticket":
            if (esAdmin) {
              // Capturamos el ID del botón que ahora SÍ es el ticket
              const ticketAReactivar = msg.interactive.button_reply.id;

              if (ticketAReactivar && ticketAReactivar !== "btn_0") {
                console.log(`✅ Reactivando ticket real: ${ticketAReactivar}`);

                await actualizarEstadoCRM(ticketAReactivar, {
                  Estado_Pago: "Pendiente",
                  Estado_Produccion: "En Espera",
                });

                await enviarMensaje(
                  process.env.MY_PERSONAL_NUMBER,
                  `✅ Ticket ${ticketAReactivar} reactivado en el Sheet.`,
                );
              } else {
                console.log(
                  "❌ Error: Se recibió btn_0. Revisa la función enviarBotones.",
                );
              }
            }
            break;

          // COLOCAR DENTRO DE TU SWITCH (resBtn)
          case "Confirmar Pedido":
            const datosParaPDF = estadosClientes[numeroCliente];

            if (datosParaPDF) {
              try {
                const ticketFinal = datosParaPDF.ticket;
                const rutaPDF = `./temp/Orden_${ticketFinal}.pdf`;

                // 🔍 LUPA 1: Recuperar el link de Cloudinary que se guardó al recibir la imagen
                // Asegúrate de que en el bloque de la imagen guardaste 'urlImagen' en la memoria
                const linkCloudinary = datosParaPDF.urlImagen || "";

                // 🔍 LUPA 2: Determinar si es Diurno o Nocturno al momento de confirmar
                const origenPedido = estaFueraDeHorario()
                  ? "🌙 Nocturno"
                  : "☀️ Diurno";

                // 🔍 LUPA 3: Mandar a guardar al CRM con TODOS los datos calculados
                await guardarEnCRM({
                  ticket: ticketFinal,
                  nombre: datosParaPDF.nombre,
                  numero: numeroCliente,
                  categoria: datosParaPDF.categoria,
                  notas: datosParaPDF.detalles,
                  urlImagen: linkCloudinary, // Aquí subirá el link de Cloudinary
                  precio: datosParaPDF.precioTotal, // Aquí subirá el precio ($150, etc) o "Cotización"
                  origen: origenPedido, // Pasamos el origen detectado
                });

                // Generar PDF
                await generarPDFOrden(
                  {
                    ticket: ticketFinal,
                    numero: numeroCliente,
                    categoria: datosParaPDF.categoria,
                    detalles: datosParaPDF.detalles,
                    cantidad: datosParaPDF.cantidad,
                    precioTotal: datosParaPDF.precioTotal,
                    nombre: datosParaPDF.nombre,
                  },
                  rutaPDF,
                );

                await enviarDocumento(
                  numeroCliente,
                  rutaPDF,
                  `Orden_${ticketFinal}.pdf`,
                );

                await enviarBotones(
                  numeroCliente,
                  "✅ ¡Pedido Confirmado! Tu orden ha sido registrada.",
                  ["Inicio"],
                );

                delete estadosClientes[numeroCliente];
              } catch (error) {
                console.error("❌ Error en Confirmar Pedido:", error);
              }
            }
            break;
        }
      }
      // D. CUALQUIER OTRA COSA (Video, Sticker, Audio, Documento)
      else {
        console.log(`⚠️ Tipo de mensaje no soportado: ${msg.type}`);
        await enviarMensaje(
          numeroCliente,
          ` Lo siento *${nombreCliente}*, recibí tu ${msg.type}, pero por ahora solo puedo recibir imágenes para los diseños personalizados. 👕\n\nPor favor, envíame una foto.`,
        );
      }
    } catch (err) {
      console.error("❌ Error procesando flujo:", err.message);
    }
  }
});

// ==========================================
// 4. INICIO DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
});
