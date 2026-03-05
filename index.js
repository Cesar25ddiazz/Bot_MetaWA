require("dotenv").config();
const { Redis } = require("@upstash/redis");
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
  return dia === 0 || hora >= 21 || hora < 9;
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

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function getEstado(numero) {
  const data = await redis.get(`cliente:${numero}`);
  return data || null;
}

async function setEstado(numero, datos) {
  await redis.set(`cliente:${numero}`, datos, { ex: 3600 });
}

async function delEstado(numero) {
  await redis.del(`cliente:${numero}`);
}

// ==========================================
// 1. CONFIGURACIÓN PLUG AND PLAY
// ==========================================
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
const MI_NUMERO = process.env.MY_PERSONAL_NUMBER;

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
  playera_básica: 215,
  playera_básica_mayoreo: 195,
  sudadera: 350,
  sudadera_mayoreo: 330,
  tote_bags: 150,
  boxer: 150,
  calcetines: 80,
  pijamas: 390,
  pijamas_duo: 600,
  elfo_personalizado: 150,
  almohada_silueta: 150,
  gorra: 110,
  taza_personalizada: 85,
  etiquetas: "Cotización según tamaño y cantidad",
  mdf: "Cotización según grabado, corte y tamaño",
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
    console.error("Error al escribir en Google Sheet:", error );
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
    const nombre = fila.get("Cliente") || fila.get("Nombre") || "Cliente";
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

async function consultarHistorialCRM(whatsapp) {
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

    // Buscar todas las filas del cliente
    const pedidosCliente = filas.filter((f) => {
      const celda = f.get("Whatsapp") || f.get("whatsapp") || "";
      const telSheet = celda.toString().replace(/\D/g, "");
      return telSheet.length >= 10 && telCliente.endsWith(telSheet.slice(-10));
    });

    if (!pedidosCliente.length) return null; // Cliente nuevo

    // Ordenar por fecha descendente y tomar los últimos 5
    const ultimos = pedidosCliente.slice(-5).reverse();

    // Verificar fidelidad: algún pedido en los últimos 30 días con estado Pagado
    const hace30dias = new Date();
    hace30dias.setDate(hace30dias.getDate() - 30);

    const pedidosPagadosEnMes = pedidosCliente.filter((f) => {
      const fechaStr = f.get("Fecha") || "";
      const pago = f.get("Estado_Pago") || "";
      try {
        const partes = fechaStr.split(",")[0].trim().split("/");
        const fecha =
          partes.length === 3
            ? new Date(`${partes[2]}-${partes[1]}-${partes[0]}`)
            : new Date(fechaStr);
        return fecha >= hace30dias && pago === "Pagado";
      } catch {
        return false;
      }
    });

    const esFiel = pedidosPagadosEnMes.length >= 4;
    // Emojis por estado de pago
    const emojoPago = (p) => {
      if (!p || p === "Pendiente") return "🕐 Pendiente";
      if (p === "Pagado") return "✅ Pagado";
      if (p === "Anticipo") return "💰 Anticipo";
      if (p === "Cancelado") return "🚫 Cancelado";
      return p;
    };

    // Emojis por estado de producción
    const emojoProduccion = (p) => {
      if (!p || p === "En Cola") return "📋 En Cola";
      if (p === "En Proceso") return "⚙️ En Proceso";
      if (p === "Listo") return "📦 Listo";
      if (p === "Entregado") return "🎉 Entregado";
      if (p === "Cancelado") return "🚫 Cancelado";
      return p;
    };

    let resumen = `📋 *Historial de tus pedidos*\n`;
    resumen += `_Últimos ${ultimos.length} pedido(s) registrados_\n`;
    resumen += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    ultimos.forEach((f, i) => {
      const ticket = f.get("Ticket") || "—";
      const producto = f.get("Producto") || "—";
      const total = f.get("Total_a_Pagar") || "—";
      const pago = f.get("Estado_Pago") || "Pendiente";
      const prod = f.get("Estado_Produccion") || "En Cola";
      const fecha = f.get("Fecha") || "—";
      const fechaCorta = fecha.split(",")[0] || fecha;

      resumen += `*${i + 1}.* 🆔 \`${ticket}\`\n`;
      resumen += `   📦 ${producto}\n`;
      resumen += `   💵 ${total}\n`;
      resumen += `   ${emojoPago(pago)}\n`;
      resumen += `   ${emojoProduccion(prod)}\n`;
      resumen += `   📅 ${fechaCorta}\n`;
      if (i < ultimos.length - 1) resumen += `─────────────────────\n`;
    });

    resumen += `\n━━━━━━━━━━━━━━━━━━━━━`;

    return {
      resumen,
      esFiel,
      totalPedidos: pedidosCliente.length,
      pagadosEnMes: pedidosPagadosEnMes.length,
    };
  } catch (error) {
    console.error("❌ Error consultando historial:", error.message);
    return null;
  }
}

async function generarCupon(numeroCliente) {
  const cuponExistente = await redis.get(`cupon:${numeroCliente}`);
  if (cuponExistente) return { codigo: cuponExistente, esNuevo: false };

  // Si ya usó un cupón este mes, no generar otro
  const enfriamiento = await redis.get(`cupon:usado:${numeroCliente}`);
  if (enfriamiento) return null;

  const codigo = `FIEL-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
  await redis.set(`cupon:${numeroCliente}`, codigo, { ex: 60 * 60 * 24 * 30 });
  return { codigo, esNuevo: true };
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

    const estadoActualPedido = await getEstado(numeroCliente);
    await setEstado(numeroCliente, {
      ...estadoActualPedido,
      urlImagen: urlPermanente,
    });

    // Determinar categoria para la notificacion
    let cat = "📦 GENERAL";
    const c = comentario.toLowerCase();
    if (c.includes("taza")) cat = "☕ TAZA";
    else if (c.includes("mdf")) cat = "🪵 MDF";
    else if (c.includes("etiqueta")) cat = "🏷️ ETIQUETAS";
    else if (c.includes("playera")) cat = "👕 PLAYERA BASICA";
    else if (c.includes("playera mayoreo")) cat = "👕 PLAYERA BASICA MAYOREO";
    else if (c.includes("sudadera")) cat = "🧥 SUDADERA";
    else if (c.includes("sudadera mayoreo")) cat = "🧥 SUDADERA MAYOREO";
    else if (c.includes("tote bags")) cat = "👜 TOTE BAGS";
    else if (c.includes("gorra")) cat = "🧢 GORRA";
    else if (c.includes("boxer")) cat = "🩲 BOXER";
    else if (c.includes("calcetines")) cat = "🧦 CALCETINES";
    else if (c.includes("pijama duo")) cat = "👘 PIJAMA DUO";
    else if (c.includes("pijama")) cat = "👘 PIJAMA";
    else if (c.includes("elfo personalizado")) cat = "🧝🏽‍♂️ ELFO PERSONALIZADO";
    else if (c.includes("almohada silueta")) cat = "☁️ ALMOHADA SILUETA";

    let precioUnitario = 0;
    if (cat === "👕 PLAYERA BASICA")
      precioUnitario = Number(PRECIOS.playera_básica);
    else if (cat === "🧥 SUDADERA") precioUnitario = Number(PRECIOS.sudadera);
    else if (cat === "☕ TAZA")
      precioUnitario = Number(PRECIOS.taza_personalizada);
    else if (cat === "🏷️ ETIQUETAS") precioUnitario = Number(PRECIOS.etiquetas);
    else if (cat === "🧢 GORRA") precioUnitario = Number(PRECIOS.gorra);
    else if (cat === "👜 TOTE BAGS") precioUnitario = Number(PRECIOS.tote_bags);
    else if (cat === "🩲 BOXER") precioUnitario = Number(PRECIOS.boxer);
    else if (cat === "🧦 CALCETINES")
      precioUnitario = Number(PRECIOS.calcetines);
    else if (cat === "👘 PIJAMA DUO")
      precioUnitario = Number(PRECIOS.pijamas_duo);
    else if (cat === "👘 PIJAMA") precioUnitario = Number(PRECIOS.pijamas);
    else if (cat === "🧝🏽‍♂️ ELFO PERSONALIZADO")
      precioUnitario = Number(PRECIOS.elfo_personalizado);
    else if (cat === "☁️ ALMOHADA SILUETA")
      precioUnitario = Number(PRECIOS.almohada_silueta);

    //Intenta detectar cantidad
    const numerosEnTexto = comentario.match(/\d+/);
    let cantidadDetectada = numerosEnTexto ? parseInt(numerosEnTexto[0]) : 1; //Si no se encuentra asume 1

    //Logica para etiquetas
    let totalFinal = 0;

    if (!cat.includes("ETIQUETAS") && !cat.includes("MDF")) {
      totalFinal = Number(precioUnitario) * cantidadDetectada;
    }

    let textoPresupuesto =
      cat.includes("MDF") ||
      cat.includes("ETIQUETAS") ||
      c.includes("mdf") ||
      c.includes("madera") ||
      c.includes("llavero") ||
      cat.includes("etiquetas")
        ? "Sujeto a cotización según tamaño y cantidad"
        : `$${totalFinal} MXN (${cantidadDetectada} pzs)`;

    //Guardar en CRM
    const estadoActualPedido2 = await getEstado(numeroCliente);

    // 🔍 Si el cliente ya mandó texto extra, usamos los detalles acumulados en Redis
    const detallesAcumulados = estadoActualPedido2?.detalles || comentario;
    const textoFinal = detallesAcumulados.toLowerCase();

    // Re-detectar categoría con detalles acumulados si sigue siendo GENERAL
    if (cat === "📦 GENERAL") {
      if (textoFinal.includes("taza")) cat = "☕ TAZA";
      else if (textoFinal.includes("mdf") || textoFinal.includes("madera"))
        cat = "🪵 MDF";
      else if (textoFinal.includes("etiqueta")) cat = "🏷️ ETIQUETAS";
      else if (textoFinal.includes("playera")) cat = "👕 PLAYERA BASICA";
      else if (textoFinal.includes("sudadera")) cat = "🧥 SUDADERA";
      else if (textoFinal.includes("gorra")) cat = "🧢 GORRA";
    }

    // Re-detectar cantidad con detalles acumulados
    const numerosFinales = detallesAcumulados.match(/\d+/);
    if (numerosFinales) cantidadDetectada = parseInt(numerosFinales[0]);

    // Re-calcular precio con datos actualizados
    if (cat === "👕 PLAYERA BASICA")
      precioUnitario =
        cantidadDetectada >= 10
          ? Number(PRECIOS.playera_básica_mayoreo)
          : Number(PRECIOS.playera_básica);
    else if (cat === "🧥 SUDADERA")
      precioUnitario =
        cantidadDetectada >= 6
          ? Number(PRECIOS.sudadera_mayoreo)
          : Number(PRECIOS.sudadera);
    else if (cat === "☕ TAZA")
      precioUnitario = Number(PRECIOS.taza_personalizada);
    else if (cat === "🏷️ ETIQUETAS") precioUnitario = Number(PRECIOS.etiquetas);
    else if (cat === "🧢 GORRA") precioUnitario = Number(PRECIOS.gorra);
    else if (cat === "👜 TOTE BAGS") precioUnitario = Number(PRECIOS.tote_bags);
    else if (cat === "🩲 BOXER") precioUnitario = Number(PRECIOS.boxer);
    else if (cat === "🧦 CALCETINES")
      precioUnitario = Number(PRECIOS.calcetines);
    else if (cat === "👘 PIJAMA DUO")
      precioUnitario = Number(PRECIOS.pijamas_duo);
    else if (cat === "👘 PIJAMA") precioUnitario = Number(PRECIOS.pijamas);
    else if (cat === "🧝🏽‍♂️ ELFO PERSONALIZADO")
      precioUnitario = Number(PRECIOS.elfo_personalizado);
    else if (cat === "☁️ ALMOHADA SILUETA")
      precioUnitario = Number(PRECIOS.almohada_silueta);

    if (cat.includes("ETIQUETAS")) {
      totalFinal = (cantidadDetectada / 100) * Number(PRECIOS.etiquetas);
    } else {
      totalFinal = Number(precioUnitario) * cantidadDetectada;
    }
    totalFinal = Math.round(totalFinal * 100) / 100;

    textoPresupuesto =
      cat.includes("MDF") ||
      textoFinal.includes("mdf") ||
      textoFinal.includes("madera")
        ? "Sujeto a cotización según diseño"
        : `$${totalFinal} MXN (${cantidadDetectada} pzs)`;

    await setEstado(numeroCliente, {
      ...estadoActualPedido2,
      ticket: ticket,
      nombre: nombreCliente,
      numero: numeroCliente,
      categoria: cat,
      notas: detallesAcumulados,
      detalles: detallesAcumulados,
      urlImagen: urlPermanente,
      precio: cat.includes("MDF") ? "Cotización" : textoPresupuesto,
      precioTotal: cat.includes("MDF") ? "Cotización" : textoPresupuesto,
    });

    //Notidicacion detallada
    const mensajeAdmin =
      `🛠️ *PRE-ORDEN-RECIBIDA:* 🛠️\n` +
      `-----------------------------\n` +
      `🆔 *Ticket:* \`${ticket}\`\n` +
      `👤 *Cliente:* ${nombreCliente}\n` +
      `📱 *Whatsapp:* wa.me/${numeroCliente}\n` +
      `📦 *CAT:* ${cat}\n` +
      `📝 *Notas:* ${detallesAcumulados}\n` +
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
        .fillColor(colorNegro )
        .fontSize(12)
        .font("Helvetica-Bold")
        .text("NUESTRAS REDES SOCIALES", 70, marketingY + 15);
      doc
        .fontSize(10)
        .font("Helvetica")
        .text("• Instagram: @lyn_shop1", 70, marketingY + 40)
        //.text("• TikTok: @", 70, marketingY + 55)
        .text("• Facebook: facebook.com/lyn_shopp.39", 70, marketingY + 70);

      const qrData = `https://wa.me/${process.env.MY_PERSONAL_NUMBER}?text=Hola, quisiera informes de los productos`;
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
        const estadoPrevio = (await getEstado(numeroCliente)) || {};

        // 🔒 Marcamos que estamos procesando para bloquear textos prematuros
        await setEstado(numeroCliente, {
          ...estadoPrevio,
          procesando: true,
        });

        // Si el cliente mandó imagen sin haber elegido categoría antes (ej: Reinicio)
        if (!estadoPrevio.categoria) {
          await enviarBotones(
            numeroCliente,
            "⚠️ Por favor, primero selecciona una categoría: ",
            ["Textil", "Tazas y MDF", "Etiquetas"],
          );
          return;
        }

        if (estadoPrevio.categoria === "TAZAS Y MDF") {
          const textoAnalizar = comentarioImagen.toLowerCase();
          const tieneMaterial =
            textoAnalizar.includes("taza") ||
            textoAnalizar.includes("mdf") ||
            textoAnalizar.includes("madera") ||
            textoAnalizar.includes("laser") ||
            textoAnalizar.includes("grabado") ||
            textoAnalizar.includes("corte");

          if (!tieneMaterial) {
            // 🔓 Resetear procesando para no bloquear al cliente
            await setEstado(numeroCliente, {
              ...estadoPrevio,
              procesando: false,
            });
            await enviarMensaje(
              numeroCliente,
              "⚠️ *Dato importante:* Olvidaste especificar si tu diseño es para una *Taza* o para *MDF* en la descripción.\n\n" +
                "Por favor, vuelve a enviar la imagen y escribe para qué material es (ejemplo: *2 tazas* o *corte en mdf*). ✨",
            );
            return;
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
            ? `$${cantidad * 85}`
            : "Cotización según tamaño y cantidad";

        await setEstado(numeroCliente, {
          ...estadoPrevio,
          esperandoDetallesExtra: true,
          procesando: true, // 👈 mantener el flag activo
          imageId: idDeLaImagen,
          detalles: comentarioImagen,
          cantidad: cantidad,
          ticket: ticketGenerado,
          precioTotal: precioCalculado,
        });

        const nombreRegistrado = await buscarNombreEnSheets(numeroCliente);

        //Cliente ya existe en excel
        if (nombreRegistrado) {
          console.log(`Cliente reconocido: ${nombreRegistrado}`);
          const estadoPrevioRegistrado = await getEstado(numeroCliente);
          const lockKey = `lock:${idDeLaImagen}`;
          const lockObtenido = await redis.set(lockKey, "1", {
            nx: true,
            ex: 30,
          });
          if (!lockObtenido) {
            console.log("Duplicado detectado, ignorando...");
            return;
          }
          await setEstado(numeroCliente, {
            ...estadoPrevioRegistrado,
            nombre: nombreRegistrado,
            ticket: ticketGenerado,
            cantidad: cantidad,
            precioTotal: precioCalculado,
            detalles: comentarioImagen,
            imageId: idDeLaImagen,
            esperandoDetallesExtra: true,
            esperandoNombre: false,
            procesando: false,
          });

          await procesarPedidoDetallado(
            nombreRegistrado,
            numeroCliente,
            idDeLaImagen,
            comentarioImagen,
            ticketGenerado,
          );

          const estadoConPrecio = await getEstado(numeroCliente);
          const precioFinal = estadoConPrecio?.precioTotal || precioCalculado;

          const saludo = estaFueraDeHorario()
            ? `🌙 *¡Hola de nuevo, ${nombreRegistrado}!*\n\n` +
              `Recibimos tu diseño fuera de horario, lo revisaremos mañana a primera hora.\n\n` +
              `🆔 *Ticket:* ${ticketGenerado}\n\n` +
              `💵 *Presupuesto estimado:* ${precioFinal}\n\n` +
              `Cuando estés listo, confirma tu pedido para generar tu orden en PDF. ✨`
            : `✅ *¡Diseño recibido!*\n\n` +
              `👤 *Cliente:* ${nombreRegistrado}\n\n` +
              `🆔 *Ticket:* ${ticketGenerado}\n\n` +
              `💵 *Presupuesto estimado:* ${precioFinal}\n\n` +
              `Puedes agregar más detalles o confirmar tu pedido para generar tu orden en PDF. ✨`;
          await enviarBotones(numeroCliente, saludo, [
            "Confirmar Pedido",
            "Hablar con Asesor",
          ]);
          return;
        }
        //Guardamos el estado donde le cliente manda su foto y esperamos su nombre
        await setEstado(numeroCliente, {
          esperandoNombre: false,
          esperandoDetallesExtra: true,
          ticket: ticketGenerado,
          imageId: idDeLaImagen,
          detalles: comentarioImagen,
          categoria: estadoPrevio.categoria || "📦 GENERAL",
          cantidad: cantidad,
          precioTotal: precioCalculado,
          nombre: "Pendiente",
        });

        await procesarPedidoDetallado(
          "Pendiente",
          numeroCliente,
          idDeLaImagen,
          comentarioImagen,
          ticketGenerado,
        );

        const estadoConPrecioNuevo = await getEstado(numeroCliente);
        const precioFinalNuevo =
          estadoConPrecioNuevo?.precioTotal || precioCalculado;

        await enviarBotones(
          numeroCliente,
          `📸 *¡Imagen recibida con éxito!*\n\n` +
            `🆔 *Ticket:* ${ticketGenerado}\n` +
            `💵 *Presupuesto estimado:* ${precioFinalNuevo}\n\n` +
            `Puedes agregar más detalles o confirmar tu pedido. ✨`,
          ["Confirmar Pedido", "Hablar con Asesor"],
        );
        return;
      }

      // B. SI ENVÍAN TEXTO
      else if (msg.type === "text") {
        //Limpiamos el texto del cliente
        const textoCliente = msg.text.body.toLowerCase().trim();
        const esAdmin = numeroCliente === process.env.MY_PERSONAL_NUMBER;

        // 🎯 PRIORIDAD 1: Esperando nombre para confirmar pedido
        const estadoConfirmacion = await getEstado(numeroCliente);
        if (estadoConfirmacion?.esperandoNombreConfirmacion) {
          const nombreProporcionado = msg.text.body.trim();
          const esComandoNombre =
            nombreProporcionado.toUpperCase().includes("PED-") ||
            nombreProporcionado.toLowerCase().includes("estatus") ||
            nombreProporcionado.toLowerCase().startsWith("pago ") ||
            nombreProporcionado.toLowerCase().startsWith("pagado ") ||
            nombreProporcionado.toLowerCase().startsWith("anticipo ") ||
            nombreProporcionado.toLowerCase().startsWith("cancelar");

          if (!esComandoNombre) {
            if (!estadoConfirmacion.ticket) {
              await delEstado(numeroCliente);
              await enviarBotones(
                numeroCliente,
                "¡Ups! Sesión expirada. Por favor, selecciona la categoría de nuevo.",
                ["Catalogo", "Personalizar"],
              );
              return;
            }
            await setEstado(numeroCliente, {
              ...estadoConfirmacion,
              nombre: nombreProporcionado,
              esperandoNombreConfirmacion: false,
            });
            const mensajeAdmin =
              `👤 *NUEVO CLIENTE REGISTRADO*\n` +
              `Nombre: ${nombreProporcionado}\n` +
              `Ticket: ${estadoConfirmacion.ticket}\n` +
              `WhatsApp: wa.me/${numeroCliente}`;
            await enviarMensaje(process.env.MY_PERSONAL_NUMBER, mensajeAdmin);
            await enviarBotones(
              numeroCliente,
              `¡Mucho gusto, *${nombreProporcionado}*! ✨\n\n¿Confirmamos tu pedido?`,
              ["Confirmar Pedido", "Hablar con Asesor"],
            );
            return;
          }
          // Si es un comando, cae a la lógica normal de abajo
        }

        // 🎯 PRIORIDAD 2: Historial de pedidos
        if (
          textoCliente.includes("mis pedidos") ||
          textoCliente.includes("mis compras") ||
          textoCliente.includes("historial")
        ) {
          const resultado = await consultarHistorialCRM(numeroCliente);

          if (!resultado) {
            // Cliente nuevo sin pedidos
            await enviarBotones(
              numeroCliente,
              `✨ *¡Bienvenido!*\n\n` +
                `Aún no tienes pedidos registrados con nosotros.\n\n` +
                `Estamos listos para crear algo especial para ti. ` +
                `Selecciona una categoría y empieza tu primer pedido ahora. 🎨`,
              ["Personalizar", "Catalogo", "Precios"],
            );
            return;
          }

          // Cliente con historial
          await enviarMensaje(numeroCliente, resultado.resumen);
          await delay(1000);

          if (resultado.esFiel) {
            const cuponResultado = await generarCupon(numeroCliente);

            if (!cuponResultado) {
              // Ya usó su cupón este mes
              await enviarBotones(
                numeroCliente,
                `🏆 *¡Eres cliente VIP!*\n\n` +
                `Ya canjeaste tu cupón este mes. ¡Sigue comprando para ganar el siguiente! 🌟`,
                ["Nuevo Pedido", "Hablar con Asesor"]
              );
              return;
            }

            const { codigo: codigoCupon, esNuevo } = cuponResultado;
            await delay(800);
            await enviarMensaje(
              numeroCliente,
              `🏆 *¡Eres un cliente VIP!*\n\n` +
              `${esNuevo
                ? "Como reconocimiento a tus 4 compras este mes, te hemos generado un cupón exclusivo:"
                : "Tu cupón activo es:"}\n\n` +
              `┌─────────────────────┐\n` +
              `│  🎟️  *${codigoCupon}*  │\n` +
              `└─────────────────────┘\n\n` +
              `_Válido por 30 días. Al confirmar tu próximo pedido presiona_ *"Aplicar Cupón 10%"*`
            );
            await delay(800);
            await enviarBotones(
              numeroCliente,
              `¿Listo para tu siguiente pedido con descuento?`,
              ["Personalizar", "Hablar con Asesor"]
            );
            await enviarMensaje(
              MI_NUMERO,
              `🏆 *CLIENTE VIP*\n` +
              `📱 wa.me/${numeroCliente}\n` +
              `🎟️ Cupón ${esNuevo ? "generado" : "activo"}: *${codigoCupon}*\n` +
              `📦 Total de pedidos: ${resultado.totalPedidos}`
            );
          } else {
            // Cliente con historial pero sin compra reciente
            const pagadosEnMes = resultado.pagadosEnMes;
            const faltan = Math.max(0, 4 - pagadosEnMes);

            await enviarBotones(
              numeroCliente,
              `¡Gracias por tu preferencia! 🙌\n\n` +
                `📦 *Pedidos este mes:* ${pagadosEnMes} de 4\n` +
                `${"🟢".repeat(pagadosEnMes)}${"⚪".repeat(faltan)}\n\n` +
                `Te faltan *${faltan} compra(s)* para desbloquear tu cupón VIP de *10% de descuento*. ¡Sigue así! 🌟`,
              ["Nuevo Pedido", "Hablar con Asesor"],
            );
          }
          return;
        }

        const estadoTexto = await getEstado(numeroCliente);

        // 🔒 Si la imagen aún está procesándose, pedimos que espere
        if (estadoTexto?.procesando) {
          // Guardamos el texto silenciosamente en Redis para que procesarPedidoDetallado lo encuentre
          const detallesPendientes =
            (estadoTexto.detalles || "") + " / " + msg.text.body.trim();
          await setEstado(numeroCliente, {
            ...estadoTexto,
            detalles: detallesPendientes,
          });
          console.log(
            "📥 Texto guardado durante procesamiento:",
            msg.text.body.trim(),
          );
          return;
        }

        if (
          estadoTexto?.esperandoDetallesExtra &&
          !estadoTexto?.esperandoNombre
        ) {
          const esComando =
            [
              "hola",
              "inicio",
              "catalogo",
              "personalizar",
              "confirmar pedido",
              "tallas",
              "precios",
              "reiniciar",
              "cancelar",
              "mis pedidos",
              "mis compras",
              "historial",
            ].includes(textoCliente) || textoCliente.match(/PED-\d+/i);

          if (!esComando) {
            const lockTexto = `lock:msg:${msg.id}`;
            const lockTextoObtenido = await redis.set(lockTexto, "1", {
              nx: true,
              ex: 30,
            });
            if (!lockTextoObtenido) {
              console.log("Mensaje duplicado detectado, ignorando...");
              return;
            }
            const estadoFresco = await getEstado(numeroCliente);
            const textoAcumulado =
              (estadoFresco.detalles || "") + " / " + msg.text.body.trim();
            const textoLower = textoAcumulado.toLowerCase();

            // 🔍 Re-detectar categoría si aún es GENERAL o vacía
            let catActualizada = estadoFresco.categoria || "📦 GENERAL";
            if (catActualizada === "📦 GENERAL") {
              if (textoLower.includes("taza")) catActualizada = "☕ TAZA";
              else if (
                textoLower.includes("mdf") ||
                textoLower.includes("madera")
              )
                catActualizada = "🪵 MDF";
              else if (textoLower.includes("etiqueta"))
                catActualizada = "🏷️ ETIQUETAS";
              else if (textoLower.includes("playera"))
                catActualizada = "👕 PLAYERA BASICA";
              else if (textoLower.includes("sudadera"))
                catActualizada = "🧥 SUDADERA";
              else if (textoLower.includes("gorra"))
                catActualizada = "🧢 GORRA";
            }

            // 🔍 Re-detectar cantidad
            const numerosEnTexto = textoAcumulado.match(/\d+/);
            const cantidadActualizada = numerosEnTexto
              ? parseInt(numerosEnTexto[0])
              : estadoFresco.cantidad || 1;

            // 🔍 Re-calcular precio si antes era Cotización y ahora ya sabemos la categoría
            let precioActualizado = estadoFresco.precioTotal;
            if (
              catActualizada !== "📦 GENERAL" &&
              (estadoFresco.precioTotal === "Cotización" ||
                !estadoFresco.precioTotal)
            ) {
              if (catActualizada.includes("MDF")) {
                precioActualizado = "Cotización según grabado, corte y tamaño";
              } else if (catActualizada.includes("ETIQUETAS")) {
                precioActualizado = "Cotización según tamaño y cantidad";
              } else {
                const precioUnitario =
                  catActualizada === "👕 PLAYERA BASICA"
                    ? cantidadActualizada >= 10
                      ? Number(PRECIOS.playera_básica_mayoreo)
                      : Number(PRECIOS.playera_básica)
                    : catActualizada === "🧥 SUDADERA"
                      ? cantidadActualizada >= 6
                        ? Number(PRECIOS.sudadera_mayoreo)
                        : Number(PRECIOS.sudadera)
                      : catActualizada === "🧢 GORRA"
                        ? Number(PRECIOS.gorra)
                        : catActualizada === "☕ TAZA"
                          ? Number(PRECIOS.taza_personalizada)
                          : catActualizada === "👜 TOTE BAGS"
                            ? Number(PRECIOS.tote_bags)
                            : catActualizada === "🩲 BOXER"
                              ? Number(PRECIOS.boxer)
                              : catActualizada === "🧦 CALCETINES"
                                ? Number(PRECIOS.calcetines)
                                : catActualizada === "👘 PIJAMA DUO"
                                  ? Number(PRECIOS.pijamas_duo)
                                  : catActualizada === "👘 PIJAMA"
                                    ? Number(PRECIOS.pijamas)
                                    : 0;

                if (precioUnitario > 0) {
                  const etiquetaMayoreo =
                    (catActualizada === "👕 PLAYERA BASICA" &&
                      cantidadActualizada >= 10) ||
                    (catActualizada === "🧥 SUDADERA" &&
                      cantidadActualizada >= 6)
                      ? " (precio mayoreo)"
                      : "";
                  precioActualizado = `$${precioUnitario * cantidadActualizada} MXN (${cantidadActualizada} pzs${etiquetaMayoreo})`;
                }
              }
            }

            await setEstado(numeroCliente, {
              ...estadoFresco,
              detalles: textoAcumulado,
              notas: textoAcumulado,
              categoria: catActualizada,
              cantidad: cantidadActualizada,
              precioTotal: precioActualizado,
            });

            // Verificar si el cliente escribió un cupón
            const textoCupon = msg.text.body.trim().toUpperCase();
            const cuponGuardado = await redis.get(`cupon:${numeroCliente}`);
            let descuentoAplicado = false;

            if (cuponGuardado && textoCupon === cuponGuardado.toUpperCase()) {
              const precioSinDescuento =
                precioActualizado || estadoFresco.precioTotal;
              const matchPrecio = precioSinDescuento.match(/\$(\d+(\.\d+)?)/);

              if (matchPrecio) {
                const precioOriginal = parseFloat(matchPrecio[1]);
                const precioConDescuento = Math.round(precioOriginal * 0.9);
                precioActualizado = `$${precioConDescuento} MXN (${cantidadActualizada} pzs — 10% descuento aplicado ✅)`;
                descuentoAplicado = true;

                await setEstado(numeroCliente, {
                  ...estadoFresco,
                  detalles: textoAcumulado,
                  notas: textoAcumulado,
                  categoria: catActualizada,
                  cantidad: cantidadActualizada,
                  precioTotal: precioActualizado,
                  cuponAplicado: cuponGuardado,
                });
              }
            }

            if (!descuentoAplicado) {
              await setEstado(numeroCliente, {
                ...estadoFresco,
                detalles: textoAcumulado,
                notas: textoAcumulado,
                categoria: catActualizada,
                cantidad: cantidadActualizada,
                precioTotal: precioActualizado,
              });
            }

            const precioMostrar =
              precioActualizado !== estadoFresco.precioTotal
                ? `\n💵 *Presupuesto actualizado:* ${precioActualizado}`
                : "";

            const mensajeCupon = descuentoAplicado
              ? `\n\n🎟️ *¡Cupón VIP aplicado!* Tu descuento del 10% ha sido registrado.`
              : "";

            await enviarBotones(
              numeroCliente,
              `📝 *Nota añadida:* "${msg.text.body.trim()}"${precioMostrar}${mensajeCupon}\n\n¿Deseas agregar algo más o confirmamos tu pedido?`,
              ["Confirmar Pedido", "Hablar con Asesor"],
            );
            return;
          }
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
          "negro",
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
          const estadoBienvenida = await getEstado(numeroCliente);
          if (estadoBienvenida?.ticket) {
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

          await delEstado(numeroCliente);
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
            `👕 *Playera mayoreo (10pzas):* ${PRECIOS.playera_básica_mayoreo}\n` +
            `🧥 *Sudadera con Diseño:* ${PRECIOS.sudadera}\n` +
            `🧥 *Sudadera mayoreo (6pzas):* ${PRECIOS.sudadera_mayoreo}\n` +
            `👘 *Pijama duo:* ${PRECIOS.pijamas_duo}\n` +
            `👘 *Pijama personalizada:* ${PRECIOS.pijamas}\n` +
            `🩲 *Boxer:* ${PRECIOS.boxer}\n` +
            `🧦 *Calcetines:* ${PRECIOS.calcetines}\n` +
            `🧢 *Gorra estampada:* ${PRECIOS.gorra}\n` +
            `👜 *Tote Bags (bolsa manta):* ${PRECIOS.tote_bags}\n` +
            `🧝🏽‍♂️ *Elfo personalizado:* ${PRECIOS.elfo_personalizado}\n` +
            `☁️ *Almohada silueta:* ${PRECIOS.almohada_silueta}\n` +
            `☕ *Taza Personalizada:* ${PRECIOS.taza_personalizada}\n` +
            `_Precios sujetos a cambios según el diseño MDF o Etiquetas._\n` +
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
        const estadoFinal = await getEstado(numeroCliente);
        if (estadoFinal?.ticket) {
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
              Tazas_y_MDF:
                "https://res.cloudinary.com/dvm55hnav/image/upload/v1772506937/Catalogo%20Tazas%20y%20MDF.pdf",
              Etiquetas:
                "https://res.cloudinary.com/dvm55hnav/image/upload/v1771967564/Catalogo%20TEXTIL.pdf",
            };
            await enviarMensaje(
              numeroCliente,
              `📂 *Nuestros Catálogos*\n\n` +
                `👕 *Textil:* ${Catalogos.textil}\n\n` +
                `☕🪵 *Tazas y MDF:* ${Catalogos.Tazas_y_MDF}\n\n` +
                `🏷️ *Etiquetas y Llaveros:* ${Catalogos.Etiquetas}\n\n` +
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
            👕 *Playera personalizada:* ${PRECIOS.playera_básica}
            👕 *Playera mayoreo (10pzas):* ${PRECIOS.playera_básica_mayoreo}
            🧥 *Sudadera con Diseño:* ${PRECIOS.sudadera}
            🧥 *Sudadera mayoreo (6pzas):* ${PRECIOS.sudadera_mayoreo}
            👘 *Pijama duo:* ${PRECIOS.pijamas_duo}
            👘 *Pijama personalizada:* ${PRECIOS.pijamas}
            🩲 *Boxer:* ${PRECIOS.boxer}
            🧦 *Calcetines:* ${PRECIOS.calcetines}
            🧢 *Gorra estampada:* ${PRECIOS.gorra}
            👜 *Tote Bags (bolsa manta):* ${PRECIOS.tote_bags}
            🧝🏽‍♂️ *Elfo personalizado:* ${PRECIOS.elfo_personalizado}
            ☁️ *Almohada silueta* ${PRECIOS.almohada_silueta}
            ☕ *Taza Personalizada:* ${PRECIOS.taza_personalizada}\n
            _Precios sujetos a cambios o según el diseño MDF o Etiquetas_`;
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
            console.log("iniciando busqueda para:", numeroCliente);
            await delEstado(numeroCliente);

            await setEstado(numeroCliente, {
              nombre: nombreRegistrado || null,
              esperandoNombre: false,
              categoria: "TEXTIL",
            });
            await enviarMensaje(
              numeroCliente,
              "👕 *Linea textil (Playeras, Sudaderas y calcetas)*\n\n1. Envía la imagen de tu diseño.\n2. En la descripción escribe: *Talla, Color y que tipo deprenda se estampara*.",
            );
            break;

          case "Tazas y MDF":
            await delEstado(numeroCliente);

            await setEstado(numeroCliente, {
              nombre: nombreRegistrado || null,
              esperandoNombre: false,
              categoria: "TAZAS Y MDF",
            });
            await enviarMensaje(
              numeroCliente,
              "☕*Tazas y madera MDF*🪵\n\nEnvía tu imagen o diseño especificando tus instrucciones en:\n- Taza Personalizada\n- Grabado/Corte láser en MDF",
            );
            break;

          case "Etiquetas":
            await delEstado(numeroCliente);

            await setEstado(numeroCliente, {
              nombre: nombreRegistrado || null,
              esperandoNombre: false,
              categoria: "ETIQUETAS",
            });
            await enviarMensaje(
              numeroCliente,
              "🏷️ *Etiquetas*\nEnvía tu logo y menciona las *medidas* y la *cantidad* que necesitas.",
            );
            break;

          case "Inicio":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            await delEstado(numeroCliente);
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
            const estadoCancelacion = await getEstado(numeroCliente);
            let ticketParaBorrar = estadoCancelacion?.ticket;

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
                  estadoCancelacion?.categoria || "No especificado";
                const nombreDelCliente = estadoCancelacion?.nombre || "Cliente";

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
                await enviarBotones(
                  numeroCliente,
                  `🚫 Tu pedido *${ticketParaBorrar}* ha sido cancelado exitosamente.`,
                  ["Inicio"],
                );

                await delEstado(numeroCliente);
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
            const datosParaPDF = await getEstado(numeroCliente);

            if (datosParaPDF) {
              // 🎟️ Si tiene cupón activo y no lo ha aplicado, ofrecer botón
              const cuponActivo = await redis.get(`cupon:${numeroCliente}`);
              if (cuponActivo && !datosParaPDF.cuponAplicado) {
                await setEstado(numeroCliente, {
                  ...datosParaPDF,
                  esperandoAplicarCupon: true,
                });
                await enviarBotones(
                  numeroCliente,
                  `🎟️ *Tienes un cupón VIP activo:* \`${cuponActivo}\`\n\n` +
                  `¿Deseas aplicar tu *10% de descuento* en este pedido?`,
                  ["Aplicar Cupón 10%", "Continuar sin cupón"]
                );
                break;
              }

              // Si el nombre es Pendiente, pedimos el nombre antes de generar el PDF
              if (datosParaPDF.nombre === "Pendiente") {
                await setEstado(numeroCliente, {
                  ...datosParaPDF,
                  esperandoNombreConfirmacion: true,
                });
                await enviarMensaje(
                  numeroCliente,
                  `Para generar tu orden, ¿podrías indicarnos tu *Nombre Completo*? ✨`,
                );
                break;
              }
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
                  notas: datosParaPDF.detalles, // o datosParaPDF.detalles
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

                await enviarBotones(
                  numeroCliente,
                  "✅ ¡Pedido Confirmado! Tu orden ha sido registrada. Si tienes dudas puedes cancelar tu compra",
                  [
                    {
                      type: "reply",
                      reply: {
                        // 🚩 CLAVE: El ID ahora guarda el ticket (Ej: CANCEL_PED-123)
                        id: `CANCEL_${datosParaPDF?.ticket}`,
                        title: "Cancelar Pedido",
                      },
                    },
                    "Inicio",
                  ],
                );

                // 🧹 LIMPIEZA TOTAL: Esto apaga 'esperandoDetallesExtra' y libera la memoria
                // Si usó cupón, eliminarlo de Redis para que no se reutilice
                if (datosParaPDF.cuponAplicado) {
                  await redis.del(`cupon:${numeroCliente}`);
                  console.log(
                    `🎟️ Cupón ${datosParaPDF.cuponAplicado} eliminado tras uso`,
                  );
                }
                // 🎟️ Si usó cupón, eliminarlo y activar enfriamiento 30 días
                if (datosParaPDF.cuponAplicado) {
                  await redis.del(`cupon:${numeroCliente}`);
                  await redis.set(`cupon:usado:${numeroCliente}`, "1", { ex: 60 * 60 * 24 * 30 });
                  console.log(`🎟️ Cupón canjeado. Enfriamiento activado.`);
                }
                // 🧹 LIMPIEZA TOTAL
                await delEstado(numeroCliente);
              } catch (error) {
                console.error("❌ Error en Confirmar Pedido:", error);
              }
            }
            break;

            case "Aplicar Cupón 10%":
            const estadoCupon = await getEstado(numeroCliente);
            const codigoActivo = await redis.get(`cupon:${numeroCliente}`);

            if (estadoCupon && codigoActivo) {
              const matchPrecio = (estadoCupon.precioTotal || "").match(/\$(\d+(\.\d+)?)/);

              if (matchPrecio) {
                const precioOriginal = parseFloat(matchPrecio[1]);
                const precioConDescuento = Math.round(precioOriginal * 0.90);
                const precioFinalCupon = `$${precioConDescuento} MXN (${estadoCupon.cantidad} pzs — 10% descuento VIP ✅)`;

                await setEstado(numeroCliente, {
                  ...estadoCupon,
                  precioTotal: precioFinalCupon,
                  cuponAplicado: codigoActivo,
                  esperandoAplicarCupon: false,
                });
                await enviarBotones(
                  numeroCliente,
                  `✅ *¡Descuento aplicado!*\n\n` +
                  `💵 *Precio original:* $${precioOriginal} MXN\n` +
                  `🎟️ *Descuento VIP 10%:* -$${Math.round(precioOriginal * 0.10)} MXN\n` +
                  `💰 *Total final:* $${precioConDescuento} MXN\n\n` +
                  `¿Confirmamos tu pedido?`,
                  ["Confirmar Pedido", "Hablar con Asesor"]
                );
              } else {
                // Precio es cotización, no se puede calcular automático
                await setEstado(numeroCliente, {
                  ...estadoCupon,
                  cuponAplicado: codigoActivo,
                  esperandoAplicarCupon: false,
                });
                await enviarBotones(
                  numeroCliente,
                  `🎟️ *Cupón VIP registrado en tu pedido.*\n\n` +
                  `Al ser cotización, el asesor aplicará el 10% al validar el precio final.`,
                  ["Confirmar Pedido", "Hablar con Asesor"]
                );
              }
            }
            break;

          case "Continuar sin cupón":
            const estadoSinCupon = await getEstado(numeroCliente);
            await setEstado(numeroCliente, {
              ...estadoSinCupon,
              esperandoAplicarCupon: false,
            });
            await enviarBotones(
              numeroCliente,
              `De acuerdo, continuamos sin cupón. ¿Confirmamos tu pedido?`,
              ["Confirmar Pedido", "Hablar con Asesor"]
            );
            break;

          case "Ayuda":

          case "Ayuda":
            await enviarMensaje(
              numeroCliente,
              "🫱🏼‍🫲🏼 *No te preocupes.* Aquí te explico cómo continuar con tu pedido:\n\n" +
                "1️⃣ Si ya enviaste tu diseño, presiona *Confirmar Pedido* para generar tu orden en PDF.\n\n" +
                "2️⃣ Si deseas agregar más detalles a tu pedido, solo escríbelos aquí.\n\n" +
                "3️⃣ Si necesitas hablar con una persona, presiona *Hablar con Asesor*.\n\n" +
                "4️⃣ Si quieres cancelar y empezar de nuevo, presiona *Inicio*.",
            );
            await delay(1000);
            await enviarBotones(numeroCliente, "¿Qué deseas hacer?", [
              "Confirmar Pedido",
              "Hablar con Asesor",
              "Inicio",
            ]);
            break;

          case "ESPERANDO_DETALLES":
            const textoExtra = msg.text?.body || "";
            const estadoEsperando = await getEstado(numeroCliente);
            await setEstado(numeroCliente, {
              ...estadoEsperando,
              detalles: (estadoEsperando?.detalles || "") + " / " + textoExtra,
            });
            console.log(
              `📝 Nota añadida al ticket ${estadoEsperando?.ticket}: ${textoExtra}`,
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
