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

app.get("/keep-alive", (req, res) => {
  console.log("Ping recibido: Manteniendo el bot despierto...");
  res.status(200).send("OK");
});

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
      return `⚠️ Lo siento, no encontré información para el ticket *${ticket}*. Por favor, verifica que esté bien escrito o contacta a un asesor.`;
    }

    console.log(`✅ Fila encontrada. Actualizando ticket: ${ticket}`);

    // Extraemos los datos de la fila
    const nombre = fila.get("Nombre") || "Cliente";
    const pago = fila.get("Estado_Pago") || "Pendiente";
    const produccion = fila.get("Estado_Produccion") || "En espera";
    const concepto = fila.get("Descripcion") || "Pedido General";

    // 🟢 ESTE ES EL TEXTO QUE SE ENVÍA AL CLIENTE
    const respuesta =
      `🔍 *Estado de tu Pedido* 🔍\n\n` +
      `👤 *Cliente:* ${nombre}\n` +
      `🆔 *Ticket:* ${ticket}\n` +
      `📦 *Descripcion:* ${concepto}\n` +
      `-----------------------------\n` +
      `💰 *Pago:* ${pago}\n` +
      `🛠️ *Producción:* ${produccion}\n` +
      `-----------------------------\n` +
      `Si tienes dudas, puedes hablar con un asesor.`;

    return respuesta;
  } catch (error) {
    console.error("❌ Error al consultar en Sheets:", error.message);
    return "❌ Hubo un error al consultar tu ticket. Por favor, intenta más tarde.";
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
    else if (c.includes("playera")) cat = "👕 PLAYERA BASICA";
    else if (c.includes("sudadera")) cat = "🧥 SUDADERA";
    else if (c.includes("gorra")) cat = "🧢 GORRA";

    let precioUnitario = 0;
    if (cat === "👕 PLAYERA BASICA")
      precioUnitario = Number(PRECIOS.playera_básica);
    else if (cat === "☕ TAZA")
      precioUnitario = Number(PRECIOS.taza_personalizada);
    else if (cat === "🏷️ ETIQUETAS") precioUnitario = Number(PRECIOS.etiquetas);
    else if (cat === "🧢 GORRA") precioUnitario = Number(PRECIOS.gorra);
    else if (cat === "🧥 SUDADERA") precioUnitario = Number(PRECIOS.sudadera);

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
    estadosClientes[numeroCliente] = {
      ...estadosClientes[numeroCliente],
      ticket: ticket,
      nombre: nombreCliente,
      numero: numeroCliente,
      categoria: cat,
      notas: comentario,
      detalles: comentario,
      urlImagen: urlPermanente,
      precio: cat.includes("MDF") ? "Cotización" : textoPresupuesto,
      precioTotal: cat.includes("MDF") ? "Cotización" : textoPresupuesto,
    };

    //Notidicacion detallada
    const mensajeAdmin =
      `🛠️ *PRE-ORDEN-RECIBIDA:* 🛠️\n` +
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
    setTimeout(async () => {
      try {
        await enviarMensaje(MI_NUMERO, mensajeAdmin);
        console.log("Notificacion enviada al admin");
      } catch (e) {
        console.log("Error al enviar notificacion:", e.message);
      }
    }, 2500);

    const despedidaElegante =
      `✅ *¡Orden registrada con éxito!*\n\n` +
      `🆔 *Ticket:* ${ticket}\n\n` +
      `💵 *Presupuesto estimado:* ${textoPresupuesto}\n\n` +
      `¿Desea realizar alguna otra consulta o prefiere hablar con un *Asesor Especializado*?`;

    await delay(1500);
    await enviarBotones(numeroCliente, despedidaElegante, [
      "Hablar con Asesor",
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
    try {
      // 1. Validar que la carpeta temp existe
      const carpeta = path.dirname(pathDestino);
      if (!fs.existsSync(carpeta)) {
        fs.mkdirSync(carpeta, { recursive: true });
      }

      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const stream = fs.createWriteStream(pathDestino);

      doc.pipe(stream);

      // --- COLORES ELEGANTES ---
      const colorNegro = "#1a1a1a";
      const colorRosaPastel = "#F8C8DC"; // Rosa pastel elegante
      const colorGrisClaro = "#f6f6f6";
      const colorGrisTexto = "#666666";

      // --- ENCABEZADO ---
      doc.rect(0, 0, 612, 120).fill(colorNegro);
      doc
        .fillColor(colorRosaPastel)
        .fontSize(28)
        .font("Helvetica-Bold")
        .text("ORDEN DE TRABAJO", 50, 45);
      doc
        .fillColor("#ffffff")
        .fontSize(10)
        .font("Helvetica")
        .text(`TICKET: ${datos.ticket}`, 400, 58, { align: "right" });

      // --- INFORMACIÓN DEL CLIENTE ---
      doc
        .fillColor(colorNegro)
        .fontSize(14)
        .font("Helvetica-Bold")
        .text("INFORMACIÓN DEL PEDIDO", 50, 150);
      doc.moveTo(50, 165).lineTo(545, 165).strokeColor(colorGrisClaro).stroke();

      doc.moveDown();
      doc
        .fillColor(colorNegro)
        .fontSize(11)
        .font("Helvetica")
        .text(`Cliente: ${datos.nombre || "No registrado"}`)
        .text(`Fecha: ${new Date().toLocaleDateString()}`)
        .text(`WhatsApp: ${datos.numero}`);

      // --- TABLA DE PRODUCTOS ---
      const tableTop = 250;
      doc.rect(50, tableTop, 495, 25).fill(colorRosaPastel); // Fondo rosa pastel para el encabezado de tabla

      doc
        .fillColor(colorNegro)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("CONCEPTO / MATERIAL", 60, tableTop + 7)
        .text("CANT.", 340, tableTop + 7, { width: 50, align: "center" }) // Centrado manual
        .text("TOTAL", 440, tableTop + 7, { width: 100, align: "center" });

      const rowY = tableTop + 40;

      // LIMPIEZA DE CARACTERES EXTRAÑOS (TEXTIL)
      const categoriaLimpia = (datos.categoria || "PRODUCTO")
        .replace(/[^\x20-\x7E]/g, "")
        .replace("=", "")
        .toUpperCase();

      doc
        .font("Helvetica")
        .fillColor(colorNegro)
        .text(categoriaLimpia, 60, rowY)
        .text(`${datos.cantidad}`, 340, rowY, { width: 50, align: "center" }) // Alineado con el título
        .text(`${datos.precioTotal}`, 440, rowY, {
          width: 100,
          align: "center",
        });

      doc
        .fontSize(9)
        .fillColor(colorGrisTexto)
        .text(`Descripción / Notas: ${datos.detalles}`, 60, rowY + 25, {
          width: 400,
        });

      // --- MARKETING Y QR ---
      const marketingY = 450;
      doc
        .rect(50, marketingY, 495, 120)
        .strokeColor(colorNegro)
        .lineWidth(0.5)
        .stroke();

      doc
        .fillColor(colorNegro)
        .fontSize(12)
        .font("Helvetica-Bold")
        .text("NUESTRAS REDES SOCIALES", 70, marketingY + 15);
      doc
        .fontSize(10)
        .font("Helvetica")
        .text("• Instagram: @lyn_shop1", 70, marketingY + 40)
        //.text("• TikTok: @", 70, marketingY + 55)
        .text("• Facebook: facebook.com/lyn_shopp.39", 70, marketingY + 70);

      const qrData = `https://wa.me/5212482492723?text=Hola, quisiera informes de los productos`;
      const qrImage = await QRCode.toDataURL(qrData);
      doc.image(qrImage, 430, marketingY + 10, { width: 100 });

      // --- MEDIOS DE PAGO ---
      doc
        .fontSize(12)
        .fillColor(colorNegro)
        .font("Helvetica-Bold")
        .text("FORMAS DE PAGO ACEPTADAS", 50, 600);
      doc
        .fontSize(10)
        .font("Helvetica")
        .text("• Efectivo", 50, 620)
        .text("• Transferencia Interbancaria (SPEI)", 50, 635)
        .text("• Depósito en OXXO / 7-Eleven", 50, 650)
        .text("• Pago con Tarjeta (vía Mercado Pago)", 50, 665);

      // --- MENSAJE DE COTIZACIÓN (Centrado y corregido) ---
      if (
        datos.precioTotal.includes("Cotización") ||
        datos.precioTotal.includes("Cotizacion")
      ) {
        doc
          .fillColor("#FF0000")
          .font("Helvetica-Bold")
          .fontSize(10)
          .text(
            "⚠️ ATENCIÓN: Al ser una Cotización, el precio final será validado por un asesor.",
            50,
            685,
            { align: "center", width: 500 },
          );
      } else {
        // Si no incluye la palabra cotización en el precio, igual ponemos la advertencia al centro abajo
        doc
          .fillColor("#FF0000")
          .font("Helvetica-Bold")
          .fontSize(10)
          .text(
            "Atención: Al ser una cotización, el precio final será validado por un asesor.",
            50,
            700,
            { align: "center", width: 500 },
          );
      }

      // --- PIE DE PÁGINA ---
      doc
        .fillColor("#aaaaaa")
        .fontSize(8)
        .text(
          "Este es un documento oficial generado automáticamente por nuestro sistema.",
          0,
          780,
          { align: "center" },
        );

      doc.end();

      stream.on("finish", () => {
        console.log(`✅ PDF generado correctamente: ${datos.ticket}`);
        resolve();
      });

      stream.on("error", (err) => {
        console.error("❌ Error en el stream del PDF:", err);
        reject(err);
      });
    } catch (error) {
      console.error("❌ Error capturado en generarPDFOrden:", error);
      reject(error);
    }
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
        const estadoPrevio = estadosClientes[numeroCliente] || {};

        // Si el cliente mandó imagen sin haber elegido categoría antes (ej: Reinicio)
        if (!estadoPrevio.categoria) {
          await enviarMensaje(
            numeroCliente,
            "⚠️ Por favor, primero selecciona una categoría (Textil o Tazas).",
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
          estadosClientes[numeroCliente] = {
            ...estadosClientes[numeroCliente],
            nombre: nombreRegistrado, // Aseguramos que el nombre esté presente
            ticket: ticketGenerado,
            cantidad: cantidad,
            precioTotal: precioCalculado,
            detalles: comentarioImagen,
            imageId: idDeLaImagen,
            esperandoDetallesExtra: false,
          };

          await procesarPedidoDetallado(
            nombreRegistrado,
            numeroCliente,
            idDeLaImagen,
            comentarioImagen,
            ticketGenerado,
          );

          // ✅ Solo se activa DESPUÉS de que procesarPedidoDetallado terminó
  if (estadosClientes[numeroCliente]) {
    estadosClientes[numeroCliente].esperandoDetallesExtra = true;
  }

          const saludo = estaFueraDeHorario()
            ? `¡Hola de nuevo, ${nombreRegistrado}! 🌙 Recibimos tu diseño. Como estamos fuera de horario, lo revisaremos mañana a primera hora.\n Ticket: *${ticketGenerado}*`
            : `¡Hola ${nombreRegistrado}! ✨ Recibimos tu diseño correctamente. Generamos tu ticket: *${ticketGenerado}*.\n\n` +
              `Recuerda que debes confirmar tu pedido para generar la orden y te mande los detalles de tu compra.`;
          await enviarBotones(
            numeroCliente,
            saludo + "\n\n¿Deseas realizar otra acción?",
            ["Confirmar Pedido", "Inicio"],
          );
          return;
        }
        //Guardamos el estado donde le cliente manda su foto y esperamos su nombre
        estadosClientes[numeroCliente] = {
          esperandoNombre: true,
          esperandoDetallesExtra: true,
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
        const datosRecuperados = estadosClientes[numeroCliente];

        // 🛡️ FILTRO: Si el usuario escribe un ticket o la palabra estatus, NO lo guardamos como nombre
        if (
          nombreProporcionado.toUpperCase().includes("PED-") ||
          nombreProporcionado.toLowerCase().includes("estatus")
        ) {
          console.log(
            "Detectado ticket/estatus, saltando guardado de nombre...",
          );
          // No ponemos 'return' para que el código baje al siguiente 'else if' y procese el ticket
        } else {
          // VALIDACIÓN DE SEGURIDAD
          if (!datosRecuperados || !datosRecuperados.ticket) {
            delete estadosClientes[numeroCliente];
            await enviarBotones(
              numeroCliente,
              "¡Ups! Sesión expirada. Por favor, selecciona la categoría de nuevo.",
              ["Catalogo", "Personalizar"],
            );
            return;
          }

          estadosClientes[numeroCliente].nombre = nombreProporcionado;
          estadosClientes[numeroCliente].esperandoNombre = false;

          // IMPORTANTE: Aquí activamos la escucha de notas extras para que el siguiente mensaje sea nota
      estadosClientes[numeroCliente].esperandoDetallesExtra = true;

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
          ]);
          return; // ⛔ IMPORTANTE: Aquí termina el proceso para el nombre
        }
      }

      // B. SI ENVÍAN TEXTO
      else if (msg.type === "text") {
        //Limpiamos el texto del cliente
        const textoCliente = msg.text.body.toLowerCase().trim();
        const esAdmin = numeroCliente === process.env.MY_PERSONAL_NUMBER;

        // 🎯 PRIORIDAD MÁXIMA: Si hay pedido activo, capturamos el mensaje ANTES que cualquier otro check
  if (estadosClientes[numeroCliente]?.esperandoDetallesExtra && !estadosClientes[numeroCliente]?.esperandoNombre) {
    const esComando = [
      "inicio", "catalogo", "personalizar", "confirmar pedido", "tallas", "precios"
    ].includes(textoCliente) || textoCliente.match(/PED-\d+/i);

    if (!esComando) {
      estadosClientes[numeroCliente].detalles = (estadosClientes[numeroCliente].detalles || "") + " " + msg.text.body.trim();
      await enviarMensaje(numeroCliente, `📝 *Nota añadida:* "${msg.text.body.trim()}"\n\n¿Algo más o confirmamos?`);
      await enviarBotones(numeroCliente, "¿Todo listo?", ["Confirmar Pedido"]);
      return;
    }
    // Si es un comando, cae a la lógica normal de abajo
  }

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
          // ⚠️ Si el cliente ya tiene un ticket activo, NO borramos el estado ni saludamos de nuevo
          if (estadosClientes[numeroCliente]?.ticket) {
            await enviarMensaje(
              numeroCliente,
              "¡Hola! Sigo esperando la confirmación de tu pedido actual. 😊",
            );
            await enviarBotones(
              numeroCliente,
              "¿Deseas confirmar o necesitas ayuda?",
              ["Confirmar Pedido", "Ayuda"],
            );
            return;
          }

          delete estadosClientes[numeroCliente];
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
            `☕ *Taza Personalizada:* ${PRECIOS.taza_personalizada}\n` +
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
          try {
            const resultado = await consultarStatusCRM(ticketBusqueda);
            await enviarMensaje(numeroCliente, resultado);
          } catch (error) {
            console.error("❌ Error al procesar la consulta de ticket:", error);
            await enviarMensaje(
              numeroCliente,
              "Hubo un problema técnico al consultar tu ticket. Por favor, intenta de nuevo en unos minutos.",
            );
          }
          return;
        }

        // 9. MENSAJE NO RECONOCIDO (Si llegó hasta aquí y tiene un ticket, le pedimos confirmar)
        if (estadosClientes[numeroCliente]?.ticket) {
          await enviarMensaje(
            numeroCliente,
            `He anotado: "${msg.text.body}".\n\n¿Quieres agregar algo más o ya podemos *Confirmar Pedido*?`,
          );
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
            const Catalogos = {
              textil:
                "https://res.cloudinary.com/dvm55hnav/image/upload/v1771967564/Catalogo%20TEXTIL.pdf",
              tazas_y_regalos:
                "https://res.cloudinary.com/dvm55hnav/image/upload/v1771967564/Catalogo%20TEXTIL.pdf",
              grabado_y_corte:
                "https://res.cloudinary.com/dvm55hnav/image/upload/v1771967564/Catalogo%20TEXTIL.pdf",
            };
            await enviarMensaje(
              numeroCliente,
              `📂 *Nuestros Catálogos*\n\n` +
                `👕 *Textil:* ${Catalogos.textil}\n\n` +
                `☕ *Tazas y Regalos:* [https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf]\n\n` +
                `🪵 *Grabado y Corte MDF* [https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf]\n\n` +
                `_Echa un vistazo y cuando estés listo presiona 'Personalizar'_`,
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
            let ticketParaBorrar = estadosClientes[numeroCliente]?.ticket;

            // Rescate de ticket si es por ID de botón
            if (!ticketParaBorrar && msg.type === "interactive") {
              const idBoton = msg.interactive?.button_reply?.id || "";
              if (idBoton.startsWith("CANCEL_"))
                ticketParaBorrar = idBoton.replace("CANCEL_", "");
            }

            if (ticketParaBorrar) {
              try {
                // 1. Extraemos datos antes de borrar la memoria para el reporte Admin
                const categoriaArticulo =
                  estadosClientes[numeroCliente]?.categoria ||
                  "No especificado";
                const nombreDelCliente =
                  estadosClientes[numeroCliente]?.nombre || "Cliente";

                // 2. Actualizamos el Sheet
                await actualizarEstadoCRM(ticketParaBorrar, {
                  Estado_Pago: "Cancelado",
                  Estado_Produccion: "Cancelado",
                });

                // 3. MENSAJE AL ADMIN CON BOTÓN DE REACTIVAR
                const alertaAdmin =
                  `🚫 *PEDIDO CANCELADO POR CLIENTE*\n\n` +
                  `🆔 *Ticket:* ${ticketParaBorrar}\n` +
                  `👤 *Cliente:* ${nombreDelCliente}\n` +
                  `📱 *WhatsApp:* wa.me/${numeroCliente}\n` +
                  `📦 *Artículo:* ${categoriaArticulo}\n` +
                  `--------------------------\n` +
                  `_¿Deseas reactivar este pedido?_`;

                try {
                  // Enviamos botones al Admin
                  await enviarBotones(
                    process.env.MY_PERSONAL_NUMBER,
                    alertaAdmin,
                    [
                      {
                        type: "reply",
                        reply: {
                          id: `REACTIVAR_${ticketParaBorrar}`,
                          title: "Reactivar Ticket",
                        },
                      },
                    ],
                  );
                } catch (e) {
                  // Si fallan los botones, enviamos texto simple para no perder el aviso
                  await enviarMensaje(
                    process.env.MY_PERSONAL_NUMBER,
                    alertaAdmin,
                  );
                }

                // 4. MENSAJE AL CLIENTE
                await enviarMensaje(
                  numeroCliente,
                  `🚫 Tu pedido *${ticketParaBorrar}* ha sido cancelado exitosamente.`,
                );

                // 5. Borramos memoria
                if (estadosClientes[numeroCliente])
                  delete estadosClientes[numeroCliente];
              } catch (error) {
                console.error("❌ Error en proceso cancelación:", error);
              }
            } else {
              await enviarMensaje(
                numeroCliente,
                "❌ No detecto un pedido activo para cancelar.",
              );
            }
            break;

          case "Reactivar Ticket":
            if (esAdmin) {
              // 1. Capturamos el ID completo (ej: "REACTIVAR_PED-1771...")
              const idBotonOriginal = msg.interactive.button_reply.id;

              if (idBotonOriginal && idBotonOriginal !== "btn_0") {
                // 2. Limpiamos el ID para dejar solo el ticket real
                // Esto quita "REACTIVAR_" y deja solo "PED-XXXX"
                const ticketAReactivar = idBotonOriginal.replace(
                  "REACTIVAR_",
                  "",
                );

                console.log(`✅ Reactivando ticket real: ${ticketAReactivar}`);

                // 3. Ahora sí, la función buscará el ticket correcto en el Sheet
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

                // 🟢 LÓGICA DE PRECIO: Si es "Cotización", se queda así.
                // Si tiene el desglose, lo pasamos tal cual al Sheet.
                const precioParaSheet =
                  datosParaPDF.precioTotal || "Cotización";

                // 🔍 LUPA 3: Mandar a guardar al CRM con TODOS los datos calculados
                await guardarEnCRM({
                  ticket: datosParaPDF.ticket,
                  nombre: datosParaPDF.nombre,
                  numero: numeroCliente,
                  categoria: datosParaPDF.categoria,
                  notas: datosParaPDF.notas, // o datosParaPDF.detalles
                  urlImagen: datosParaPDF.urlImagen,
                  precio: datosParaPDF.precioTotal, // 👈 Ahora esto tendrá el desglose
                  origen: origenPedido,
                });

                // Usamos texto plano para que llegue 100% seguro
                const avisoAdmin =
                  `💰 *¡PEDIDO CONFIRMADO!* 💰\n\n` +
                  `👤 *Cliente:* ${datosParaPDF.nombre}\n` +
                  `🆔 *Ticket:* ${ticketFinal}\n` +
                  `📦 *Cat:* ${datosParaPDF.categoria}\n` +
                  `💵 *Precio:* ${precioParaSheet}\n` +
                  `📍 *Horario:* ${origenPedido}\n` +
                  `📱 *WhatsApp:* wa.me/${numeroCliente}`;

                await enviarMensaje(process.env.MY_PERSONAL_NUMBER, avisoAdmin);

                // Generar PDF
                await generarPDFOrden(
                  {
                    ticket: ticketFinal,
                    numero: numeroCliente,
                    categoria: datosParaPDF.categoria,
                    detalles: datosParaPDF.detalles,
                    cantidad: datosParaPDF.cantidad,
                    precioTotal: precioParaSheet,
                    nombre: datosParaPDF.nombre,
                  },
                  rutaPDF,
                );

                await enviarDocumento(
                  numeroCliente,
                  rutaPDF,
                  `Orden_${ticketFinal}.pdf`,
                );

                // 🚩 APAGADO DE BANDERAS: Lo hacemos justo antes del delete para asegurar limpieza
                if (estadosClientes[numeroCliente]) {
                  estadosClientes[numeroCliente].esperandoDetallesExtra = false;
                }

                await enviarBotones(
                  numeroCliente,
                  "✅ ¡Pedido Confirmado! Tu orden ha sido registrada. Si tienes dudas puedes cancelar tu compra",
                  [
                    {
                      type: "reply",
                      reply: {
                        // 🚩 CLAVE: El ID ahora guarda el ticket (Ej: CANCEL_PED-123)
                        id: `CANCEL_${estadosClientes[numeroCliente]?.ticket}`,
                        title: "Cancelar Pedido",
                      },
                    },
                    "Inicio",
                  ],
                );

                // 🧹 LIMPIEZA TOTAL: Esto apaga 'esperandoDetallesExtra' y libera la memoria
                delete estadosClientes[numeroCliente];
              } catch (error) {
                console.error("❌ Error en Confirmar Pedido:", error);
              }
            }
            break;

          case "ESPERANDO_DETALLES":
            // 1. Limpiamos el texto nuevo
            const textoExtra = msg.text?.body || "";

            // 2. Si ya tiene detalles, le ponemos una coma o un espacio para que no se peguen las palabras
            if (estadosClientes[numeroCliente].detalles) {
              estadosClientes[numeroCliente].detalles += " " + textoExtra;
            } else {
              estadosClientes[numeroCliente].detalles = textoExtra;
            }

            console.log(
              `📝 Nota añadida al ticket ${estadosClientes[numeroCliente].ticket}: ${textoExtra}`,
            );

            // 3. Opcional: Confirmar al cliente que lo escuchaste
            await enviarMensaje(
              numeroCliente,
              "✅ *Anotado.* ¿Deseas agregar algo más o ya podemos generar tu orden?",
            );

            // Aquí puedes volver a enviar los botones de "Confirmar Pedido" para que el flujo no se detenga
            await enviarBotones(
              numeroCliente,
              "¿Confirmamos los datos actuales?",
              ["Confirmar Pedido", "Inicio"],
            );
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
