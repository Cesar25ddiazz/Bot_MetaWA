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
  impresion_3d: "Sujeto a cotización según especificaciones",
  corte_laser: "Sujeto a cotización según material y medidas",
  modelado_3d: "Sujeto a cotización según complejidad del modelo",
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
      Calificacion: "Sin calificar",
      Anticipo: "Pendiente",
      Tipo_Servicio: datos.categoria || "📦 GENERAL",
      Tiempo_Estimado: datos.tiempoEstimado || "Por confirmar",
      Estado_Anticipo: "Pendiente",
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

async function actualizarCalificacionCRM(ticket, calificacion) {
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

    const fila = filas.find(
      (f) =>
        String(f.get("Ticket")).trim().toUpperCase() ===
        String(ticket).trim().toUpperCase(),
    );

    if (fila) {
      fila.set("Calificacion", calificacion);
      await fila.save();
      console.log(`⭐ Calificación guardada para ${ticket}: ${calificacion}`);
    }
  } catch (error) {
    console.error("❌ Error guardando calificación:", error.message);
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

    // Se usa la categoría guardada en Redis como base
    const estadoParaCat = await getEstado(numeroCliente);
    let cat = estadoParaCat?.categoria || "📦 GENERAL";
    const c = comentario.toLowerCase();

    // Refinar categoría con palabras clave del comentario
    if (c.includes("impresion") || c.includes("impresión") || c.includes("3d"))
      cat = "🖨️ IMPRESIÓN 3D";
    else if (
      c.includes("corte") ||
      c.includes("laser") ||
      c.includes("láser") ||
      c.includes("grabado")
    )
      cat = "✂️ CORTE LÁSER";
    else if (
      c.includes("modelado") ||
      c.includes("modelo") ||
      c.includes("diseño 3d")
    )
      cat = "🎨 MODELADO 3D";
    else if (cat === "IMPRESIÓN 3D") cat = "🖨️ IMPRESIÓN 3D";
    else if (cat === "CORTE LÁSER") cat = "✂️ CORTE LÁSER";
    else if (cat === "MODELADO 3D") cat = "🎨 MODELADO 3D";

    // Todo es cotización
    const numerosEnTexto = comentario.match(/\d+/);
    let cantidadDetectada = numerosEnTexto ? parseInt(numerosEnTexto[0]) : 1;
    let textoPresupuesto =
      "Sujeto a cotización según especificaciones del proyecto";

    // Leer estado actualizado de Redis
    const estadoActualPedido2 = await getEstado(numeroCliente);
    const detallesAcumulados = estadoActualPedido2?.detalles || comentario;
    const textoFinal = detallesAcumulados.toLowerCase();

    // Re-detectar categoría con detalles acumulados
    if (
      textoFinal.includes("impresion") ||
      textoFinal.includes("impresión") ||
      textoFinal.includes("3d")
    )
      cat = "🖨️ IMPRESIÓN 3D";
    else if (
      textoFinal.includes("corte") ||
      textoFinal.includes("laser") ||
      textoFinal.includes("láser") ||
      textoFinal.includes("grabado") ||
      textoFinal.includes("mdf")
    )
      cat = "✂️ CORTE LÁSER — MDF 3mm";
    else if (textoFinal.includes("modelado") || textoFinal.includes("modelo"))
      cat = "🎨 MODELADO 3D";

    const numerosFinales = detallesAcumulados.match(/\d+/);
    if (numerosFinales) cantidadDetectada = parseInt(numerosFinales[0]);

    // Tiempo estimado según servicio
    const tiempoEstimado = cat.includes("IMPRESIÓN 3D")
      ? "3 a 5 días hábiles"
      : cat.includes("CORTE LÁSER")
        ? "2 a 4 días hábiles"
        : cat.includes("MODELADO 3D")
          ? "3 a 7 días hábiles"
          : "Por confirmar con asesor";

    await setEstado(numeroCliente, {
      ...estadoActualPedido2,
      ticket: ticket,
      nombre: nombreCliente,
      numero: numeroCliente,
      categoria: cat,
      notas: detallesAcumulados,
      detalles: detallesAcumulados,
      urlImagen: urlPermanente,
      precio: textoPresupuesto,
      precioTotal: textoPresupuesto,
      tiempoEstimado: tiempoEstimado,
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
        .text("• Depósito en OXXO", 50, 650)
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

  // Verificación de firma de Meta para mayor seguridad
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.log("⚠️ Webhook sin firma — posible request no autorizado");
  }

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

    // Filtro: Solo procesar si es texto, botón o imagen
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
          `☀️ ¡Buenos Días! Ya estamos de vuelta. Si mandaste un proyecto anoche, un asesor lo está revisando ahora. 📝`,
        );
      }
      const esSaludoFueraHorario = [
        "hola",
        "inicio",
        "hey",
        "buenos días",
        "buenas tardes",
        "buenas noches",
        "que tal",
        "buen día",
      ].some((p) => textoCliente.includes(p));

      if (esSaludoFueraHorario) {
        await enviarMensaje(
          numeroCliente,
          `🌙 Hola ${nombreCliente}, en este momento estamos fuera de horario.\n\n` +
            `📅 *Horario de atención:*\nLunes a Viernes de 9am a 9pm\n\n` +
            `Puedes enviarnos tu imagen o referencia de proyecto y la revisaremos en cuanto abramos. ✨`,
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

        // Marcamos que estamos procesando para bloquear textos prematuros
        await setEstado(numeroCliente, {
          ...estadoPrevio,
          procesando: true,
        });

        // Si el cliente mandó imagen sin haber elegido categoría antes
        if (!estadoPrevio.categoria) {
          await enviarBotones(
            numeroCliente,
            "⚠️ Por favor, primero selecciona el servicio que necesitas:",
            ["Impresión 3D", "Corte Láser", "Modelado 3D"],
          );
          return;
        }

        if (estadoPrevio.categoria === "CORTE LÁSER") {
          const textoAnalizar = comentarioImagen.toLowerCase();
          const tieneMaterial =
            textoAnalizar.includes("madera") ||
            textoAnalizar.includes("acrilico") ||
            textoAnalizar.includes("acrílico") ||
            textoAnalizar.includes("mdf") ||
            textoAnalizar.includes("corte") ||
            textoAnalizar.includes("grabado") ||
            textoAnalizar.includes("laser") ||
            textoAnalizar.includes("láser") ||
            comentarioImagen.trim() !== "";

          if (!tieneMaterial) {
            await setEstado(numeroCliente, {
              ...estadoPrevio,
              procesando: false,
            });
            await enviarMensaje(
              numeroCliente,
              "⚠️ *Dato importante:* Por favor especifica el *material* para el corte láser.\n\n" +
                "Ejemplo: *corte en acrílico 3mm* o *grabado en madera MDF*. ✨",
            );
            return;
          }
        }

        if (!idDeLaImagen) {
          console.error("No se pudo obtener el ID de la imagen");
          return;
        }

        // CÁLCULO DE PRECIOS PARA EL PDF
        // Extraer cantidad
        const cantidadMatch = comentarioImagen.match(/\d+/);
        const cantidad = cantidadMatch ? parseInt(cantidadMatch[0]) : 1;
        const ticketGenerado = `PED-${Date.now()}`;

        let precioCalculado =
          "Sujeto a cotización según especificaciones del proyecto";

        await setEstado(numeroCliente, {
          ...estadoPrevio,
          esperandoDetallesExtra: true,
          procesando: true, //mantener el flag activo
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
              `🆔 *Tu número de pedido está en el siguiente mensaje para copiarlo fácilmente* 👇\n\n` +
              `💵 *Presupuesto:* Sujeto a cotización\n\n` +
              `Confirma tu pedido cuando estés listo. ✨`
            : `✅ *¡Diseño recibido, ${nombreRegistrado}!*\n\n` +
              `🆔 *Tu número de pedido está en el siguiente mensaje para copiarlo fácilmente* 👇\n\n` +
              `💵 *Presupuesto:* Sujeto a cotización\n\n` +
              `Puedes agregar más detalles o confirmar tu pedido. ✨`;
          await enviarBotones(numeroCliente, saludo, [
            "Confirmar Pedido",
            "Hablar con Asesor",
          ]);
          await delay(500);
          await enviarMensaje(numeroCliente, ticketGenerado); // 👈 ticket solo en mensaje aparte
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
            `🆔 *Tu número de pedido está en el siguiente mensaje para copiarlo fácilmente* 👇\n\n` +
            `💵 *Presupuesto:* Sujeto a cotización\n\n` +
            `Puedes agregar más detalles o confirmar tu pedido. ✨`,
          ["Confirmar Pedido", "Hablar con Asesor"],
        );
        await delay(500);
        await enviarMensaje(numeroCliente, ticketGenerado);
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
                ["Nuevo Pedido", "Hablar con Asesor"],
              );
              return;
            }

            const { codigo: codigoCupon, esNuevo } = cuponResultado;
            await delay(800);
            await enviarMensaje(
              numeroCliente,
              `🏆 *¡Eres un cliente VIP!*\n\n` +
                `${
                  esNuevo
                    ? "Como reconocimiento a tus 4 compras este mes, te hemos generado un cupón exclusivo:"
                    : "Tu cupón activo es:"
                }\n\n` +
                `┌─────────────────────┐\n` +
                `│  🎟️  *${codigoCupon}*  │\n` +
                `└─────────────────────┘\n\n` +
                `_Válido por 30 días. Al confirmar tu próximo pedido presiona_ *"Aplicar Cupón 20%"*`,
            );
            await delay(800);
            await enviarBotones(
              numeroCliente,
              `¿Listo para tu siguiente pedido con descuento?`,
              ["Personalizar", "Hablar con Asesor"],
            );
            await enviarMensaje(
              MI_NUMERO,
              `🏆 *CLIENTE VIP*\n` +
                `📱 wa.me/${numeroCliente}\n` +
                `🎟️ Cupón ${esNuevo ? "generado" : "activo"}: *${codigoCupon}*\n` +
                `📦 Total de pedidos: ${resultado.totalPedidos}`,
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
                `Te faltan *${faltan} compra(s)* para desbloquear tu cupón VIP de *20% de descuento*. ¡Sigue así! 🌟`,
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
              "catálogo",
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

          const esSaludo = [
            "gracias",
            "muchas gracias",
            "mil gracias",
            "grax",
            "grácias",
          ].some((p) => textoCliente.includes(p));

          if (esSaludo) {
            const estadoGracias = await getEstado(numeroCliente);

            // Respuesta según el contexto donde está el cliente
            if (
              estadoGracias?.ticket &&
              estadoGracias?.esperandoDetallesExtra
            ) {
              await enviarBotones(
                numeroCliente,
                `🙏 *¡Gracias a ti!* Es un placer atenderte.\n\n¿Continuamos con tu pedido?`,
                ["Confirmar Pedido", "Hablar con Asesor"],
              );
            } else if (estadoGracias?.ticket) {
              await enviarBotones(
                numeroCliente,
                `🙏 *¡Gracias a ti por tu preferencia!* ❤️\n\nSi necesitas algo más aquí estamos.`,
                ["Nuevo Pedido", "Mis Pedidos", "Inicio"],
              );
            } else {
              await enviarBotones(
                numeroCliente,
                `🙏 *¡Gracias a ti!* Es un placer tenerte aquí. ✨\n\n¿En qué más podemos ayudarte?`,
                ["Catalogo", "Precios", "Personalizar"],
              );
            }
            return;
          }

          // 🚫 Palabras sociales que NO deben guardarse como notas
          const esPalabraSocial = [
            "gracias",
            "ok",
            "okay",
            "okey",
            "entendido",
            "perfecto",
            "listo",
            "de acuerdo",
            "dale",
            "claro",
            "si",
            "sí",
            "no",
            "excelente",
            "bien",
            "genial",
            "👍",
            "😊",
            "🙏",
            "❤️",
            "jaja",
            "jajaja",
            "👌",
            "bueno",
            "sale",
            "va",
            "ya",
          ].includes(textoCliente);

          if (esPalabraSocial) {
            await enviarBotones(
              numeroCliente,
              `¿Deseas agregar algo más a tu pedido o lo confirmamos? ✨`,
              ["Confirmar Pedido", "Hablar con Asesor"],
            );
            return;
          }

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
            if (
              textoLower.includes("impresion") ||
              textoLower.includes("impresión") ||
              textoLower.includes("3d")
            )
              catActualizada = "🖨️ IMPRESIÓN 3D";
            else if (
              textoLower.includes("corte") ||
              textoLower.includes("laser") ||
              textoLower.includes("láser") ||
              textoLower.includes("grabado")
            )
              catActualizada = "✂️ CORTE LÁSER";
            else if (
              textoLower.includes("modelado") ||
              textoLower.includes("modelo")
            )
              catActualizada = "🎨 MODELADO 3D";

            // 🔍 Re-detectar cantidad
            const numerosDetectados = textoAcumulado.match(/\d+/);
            const cantidadActualizada = numerosDetectados
              ? parseInt(numerosDetectados[0])
              : estadoFresco.cantidad || 1;

            let precioActualizado =
              "Sujeto a cotización según especificaciones del proyecto";

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
                const precioConDescuento = Math.round(precioOriginal * 0.8);
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
              ? `\n\n🎟️ *¡Cupón VIP aplicado!* Tu descuento del 20% ha sido registrado.`
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

          // Si escribió solo "cancelar" sin ticket, buscar el activo en Redis
          if (!ticketACancelar.includes("PED-")) {
            const estadoActivoCancelar = await getEstado(numeroCliente);
            if (estadoActivoCancelar?.ticket) {
              await enviarBotones(
                numeroCliente,
                `¿Deseas cancelar tu pedido activo?\n\n🆔 *${estadoActivoCancelar.ticket}*`,
                [
                  {
                    type: "reply",
                    reply: {
                      id: `CANCEL_${estadoActivoCancelar.ticket}`,
                      title: "Cancelar Pedido",
                    },
                  },
                  "Hablar con Asesor",
                ],
              );
            } else {
              await enviarMensaje(
                numeroCliente,
                "⚠️ No encontré un pedido activo para cancelar.\n\n" +
                  "Si quieres cancelar un pedido anterior usa el formato:\n*Cancelar PED-12345*",
              );
            }
            return;
          }

          // Si escribió "cancelar PED-XXXX" con ticket específico
          if (ticketACancelar.includes("PED-")) {
            await actualizarEstadoCRM(ticketACancelar, { Estado: "Cancelado" });
            await enviarMensaje(
              numeroCliente,
              `🚫 El pedido *${ticketACancelar}* ha sido cancelado en nuestro sistema.`,
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
          // Verificar si es cliente recurrente
          const historialBienvenida =
            await consultarHistorialCRM(numeroCliente);

          await enviarMensaje(
            numeroCliente,
            `✨ *¡Hola, ${nombreCliente}!* ✨\n\n` +
              `Bienvenido a *J-3D Axis Studio* — tu espacio para hacer realidad ideas en 3D y láser.\n\n` +
              `Nos especializamos en:\n` +
              `🖨️ Impresión 3D personalizada\n` +
              `✂️ Corte y grabado láser en MDF 3mm\n` +
              `🎨 Modelado 3D a medida\n\n` +
              `Cada proyecto es único y lo tratamos como tal. ¿Cómo podemos ayudarte hoy? 🚀`,
          );
          await delay(1000);

          if (historialBienvenida && historialBienvenida.totalPedidos > 0) {
            // Cliente recurrente — mostrar opción de ver pedidos
            await enviarBotones(
              numeroCliente,
              `¡Qué gusto verte de nuevo! Tienes *${historialBienvenida.totalPedidos}* pedido(s) con nosotros. 🎉`,
              ["Personalizar", "Mis Pedidos", "Catalogo"],
            );
          } else {
            // Cliente nuevo
            await enviarBotones(
              numeroCliente,
              `Selecciona una opción para comenzar:`,
              ["Personalizar", "Catalogo", "Precios"],
            );
          }
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
            `💰 *Nuestros Servicios*\n\n` +
            `🖨️ *Impresión 3D:* ${PRECIOS.impresion_3d}\n\n` +
            `✂️ *Corte y Grabado Láser:* ${PRECIOS.corte_laser}\n\n` +
            `🎨 *Modelado 3D:* ${PRECIOS.modelado_3d}\n\n` +
            `_Cada proyecto es único. Contáctanos con tu idea y te cotizamos._`;

          await enviarBotones(numeroCliente, mensajePrecios, [
            "Personalizar",
            "Hablar con Asesor",
          ]);
          return;
        } else if (
          textoCliente.includes("catalogo") ||
          textoCliente.includes("catálogo") ||
          textoCliente.includes("servicios")
        ) {
          await enviarMensaje(
            numeroCliente,
            `📂 *Nuestros Servicios*\n\n` +
              `🖨️ *Impresión 3D* — Figuras, prototipos y piezas a medida\n` +
              `_Portafolio:_ https://res.cloudinary.com/dvm55hnav/image/upload/v1771967564/Catalogo%20TEXTIL.pdf\n\n` +
              `✂️ *Corte y Grabado Láser* — MDF 3mm, acrílico y más\n` +
              `_Portafolio:_ https://res.cloudinary.com/dvm55hnav/image/upload/v1772506937/Catalogo%20Tazas%20y%20MDF.pdf\n\n` +
              `🎨 *Modelado 3D* — Diseño digital para impresión o render\n` +
              `_Portafolio:_ https://res.cloudinary.com/dvm55hnav/image/upload/v1771967564/Catalogo%20TEXTIL.pdf\n\n` +
              `_Todos los precios son sujetos a cotización según especificaciones. ✨_`,
          );
          await delay(2000);
          await enviarBotones(
            numeroCliente,
            "¿Listo para iniciar tu proyecto?",
            ["Personalizar", "Precios"],
          );
          return;
        }

        // Asesor
        if (
          textoCliente.includes("asesor") ||
          textoCliente.includes("asesor personalizado") ||
          textoCliente.includes("hablar con alguien") ||
          textoCliente.includes("agente") ||
          textoCliente.includes("persona") ||
          textoCliente.includes("humano")
        ) {
          await enviarMensaje(
            numeroCliente,
            `🫱🏼‍🫲🏼 *Conectando con un especialista...*\n\n` +
              `He notificado a nuestro equipo. En un momento uno de nuestros asesores ` +
              `tomará la conversación para una atención personalizada. ¡Gracias por tu paciencia! 😊`,
          );
          await enviarMensaje(
            MI_NUMERO,
            `⚠️ *ATENCIÓN HUMANA:*\n` +
              `El cliente wa.me/${numeroCliente} solicita un asesor.\n` +
              `_Escribió: "${msg.text.body.trim()}"_`,
          );
          return;
        }

        // Tallas
        else if (
          textoCliente.includes("tallas") ||
          textoCliente.includes("talla") ||
          textoCliente.includes("medidas") ||
          textoCliente.includes("especificaciones")
        ) {
          await enviarMensaje(
            numeroCliente,
            `📐 *Especificaciones Técnicas*\n\n` +
              `🖨️ *Impresión 3D:*\n` +
              `• Alto x Ancho x Profundidad en mm\n` +
              `• Material: PLA, PETG, resina, etc.\n\n` +
              `✂️ *Corte Láser — MDF 3mm:*\n` +
              `• Medidas de la pieza en mm\n` +
              `• Material estándar: MDF 3mm\n` +
              `• Especificar si es corte, grabado o ambos\n\n` +
              `🎨 *Modelado 3D:*\n` +
              `• Dimensiones aproximadas\n` +
              `• Uso final del modelo\n\n` +
              `_Incluye estas medidas al enviar tu imagen. ✨_`,
          );
          await delay(2000);
          await enviarBotones(
            numeroCliente,
            "¿Listo para enviar tu proyecto?",
            ["Personalizar", "Inicio"],
          );
          return;
        }

        // Comando rápido "estado" sin necesidad de escribir el ticket
        if (
          textoCliente === "estado" ||
          textoCliente === "mis pedidos activos"
        ) {
          const historialRapido = await consultarHistorialCRM(numeroCliente);
          if (!historialRapido) {
            await enviarBotones(
              numeroCliente,
              `No encontré pedidos registrados con tu número. ¿Iniciamos uno?`,
              ["Personalizar", "Inicio"],
            );
            return;
          }
          // Filtrar solo pedidos activos (no entregados ni cancelados)
          await enviarMensaje(numeroCliente, historialRapido.resumen);
          await delay(800);
          await enviarBotones(numeroCliente, `¿Necesitas algo más?`, [
            "Nuevo Pedido",
            "Hablar con Asesor",
            "Inicio",
          ]);
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

        // 9. MENSAJE NO RECONOCIDO
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

          case "Precios":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            const listaPrecios =
              `💰 *Nuestros Servicios*\n\n` +
              `🖨️ *Impresión 3D:* ${PRECIOS.impresion_3d}\n\n` +
              `✂️ *Corte y Grabado Láser:* ${PRECIOS.corte_laser}\n\n` +
              `🎨 *Modelado 3D:* ${PRECIOS.modelado_3d}\n\n` +
              `_Cada proyecto es único. Contáctanos con tu idea y te cotizamos._`;
            await enviarMensaje(numeroCliente, listaPrecios);
            await delay(2000);
            await enviarBotones(
              numeroCliente,
              "¿Listo para iniciar tu proyecto?",
              ["Personalizar", "Hablar con Asesor", "Inicio"],
            );
            break;

          case "Catalogo": {
            await enviarMensaje(
              numeroCliente,
              `📂 *Nuestros Servicios*\n\n` +
                `🖨️ *Impresión 3D:*\nhttps://res.cloudinary.com/dvm55hnav/image/upload/v1771967564/Catalogo%20TEXTIL.pdf\n\n` +
                `✂️ *Corte y Grabado Láser:*\nhttps://res.cloudinary.com/dvm55hnav/image/upload/v1772506937/Catalogo%20Tazas%20y%20MDF.pdf\n\n` +
                `🎨 *Modelado 3D:*\nhttps://res.cloudinary.com/dvm55hnav/image/upload/v1771967564/Catalogo%20TEXTIL.pdf\n\n` +
                `_Echa un vistazo y cuando estés listo presiona 'Personalizar'_`,
            );
            await delay(2000);
            await enviarBotones(
              numeroCliente,
              "¿Te gustaría iniciar un proyecto?",
              ["Personalizar", "Precios", "Inicio"],
            );
            break;
          }

          case "Personalizar":
            const instrucciones =
              "🛠️ *Área de Personalización*\n\n" +
              "Selecciona el servicio que necesitas:\n\n" +
              "🖨️ *Impresión 3D* — Figuras, prototipos y piezas personalizadas\n" +
              "✂️ *Corte Láser* — Corte y grabado en madera, acrílico y más\n" +
              "🎨 *Modelado 3D* — Diseño de modelos para impresión o render\n\n" +
              "-----------------------------\n" +
              "🏆 *Programa VIP:* 4 pedidos en el mes = cupón 20% de descuento\n\n" +
              "🔎 Para consultar tu pedido escribe tu ticket (ej: *PED-1234*)";
            await enviarBotones(numeroCliente, instrucciones, [
              "Impresión 3D",
              "Corte Láser",
              "Modelado 3D",
            ]);
            break;

          case "Tallas":
            await enviarMensaje(
              numeroCliente,
              `📐 *Especificaciones Técnicas*\n\n` +
                `🖨️ *Impresión 3D:*\n` +
                `• Alto x Ancho x Profundidad en mm\n` +
                `• Material: PLA, PETG, resina, etc.\n\n` +
                `✂️ *Corte Láser — MDF 3mm:*\n` +
                `• Medidas de la pieza en mm\n` +
                `• Material estándar: MDF 3mm\n` +
                `• Especificar si es corte, grabado o ambos\n\n` +
                `🎨 *Modelado 3D:*\n` +
                `• Dimensiones aproximadas\n` +
                `• Uso final del modelo\n\n` +
                `_Incluye estas medidas al enviar tu imagen. ✨_`,
            );
            await delay(2000);
            await enviarBotones(
              numeroCliente,
              "¿Listo para enviar tu proyecto?",
              ["Personalizar", "Inicio"],
            );
            break;

          case "Impresión 3D":
            await delEstado(numeroCliente);
            await setEstado(numeroCliente, {
              nombre: nombreRegistrado || null,
              esperandoNombre: false,
              categoria: "IMPRESIÓN 3D",
            });
            await enviarMensaje(
              numeroCliente,
              "🖨️ *Impresión 3D Personalizada*\n\n" +
                "Envía la imagen o referencia de lo que necesitas imprimir.\n\n" +
                "En la descripción incluye:\n" +
                "• *Medidas aproximadas* (alto x ancho x profundidad)\n" +
                "• *Material preferido* (PLA, PETG, resina, etc.)\n" +
                "• *Cantidad de piezas*\n" +
                "• *Uso o función* del objeto\n\n" +
                "_Si tienes archivo STL o diseño propio, menciónalo. ✨_",
            );
            break;

          case "Corte Láser":
            await delEstado(numeroCliente);
            await setEstado(numeroCliente, {
              nombre: nombreRegistrado || null,
              esperandoNombre: false,
              categoria: "CORTE LÁSER",
            });
            await enviarMensaje(
              numeroCliente,
              "✂️ *Corte y Grabado Láser*\n\n" +
                "Envía la imagen o diseño vectorial de lo que necesitas.\n\n" +
                "En la descripción incluye:\n" +
                "• *Material* (madera MDF, acrílico, cuero, etc.)\n" +
                "• *Grosor del material* en mm\n" +
                "• *Medidas de la pieza*\n" +
                "• *Cantidad*\n" +
                "• *¿Corte, grabado o ambos?*\n\n" +
                "_Entre más detalle nos des, más precisa será la cotización. ✨_",
            );
            break;

          case "Modelado 3D":
            await delEstado(numeroCliente);
            await setEstado(numeroCliente, {
              nombre: nombreRegistrado || null,
              esperandoNombre: false,
              categoria: "MODELADO 3D",
            });
            await enviarMensaje(
              numeroCliente,
              "🎨 *Modelado 3D Personalizado*\n\n" +
                "Envía referencias, bocetos o imágenes de lo que deseas modelar.\n\n" +
                "En la descripción incluye:\n" +
                "• *Descripción detallada* del objeto o figura\n" +
                "• *Uso final* (impresión 3D, render, animación, etc.)\n" +
                "• *Medidas aproximadas* si aplica\n" +
                "• *Nivel de detalle* requerido\n\n" +
                "_Mientras más referencias nos envíes, mejor resultado obtendrás. ✨_",
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
            await enviarBotones(
              numeroCliente,
              "¡Perfecto! Vamos a crear algo nuevo. ¿Qué servicio necesitas?",
              ["Impresión 3D", "Corte Láser", "Modelado 3D"],
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
                    `¿Deseas aplicar tu *20% de descuento* en este pedido?`,
                  ["Aplicar Cupón 20%", "Continuar sin cupón"],
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
                  notas: datosParaPDF.detalles,
                  urlImagen: datosParaPDF.urlImagen,
                  precio: datosParaPDF.precioTotal,
                  origen: origenPedido,
                  tiempoEstimado:
                    datosParaPDF.tiempoEstimado || "Por confirmar",
                });

                // Usamos texto plano para que llegue 100% seguro
                const avisoAdmin =
                  `💰 *¡PEDIDO CONFIRMADO!* 💰\n\n` +
                  `👤 *Cliente:* ${datosParaPDF.nombre}\n` +
                  `🆔 *Ticket:* ${ticketFinal}\n` +
                  `📦 *Servicio:* ${datosParaPDF.categoria}\n` +
                  `💵 *Precio:* ${precioParaSheet}\n` +
                  `⏱️ *Tiempo estimado:* ${datosParaPDF.tiempoEstimado || "Por confirmar"}\n` +
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

                await enviarMensaje(
                  numeroCliente,
                  `✅ *¡Pedido Confirmado!* 🎉\n\n` +
                    `📦 *Servicio:* ${datosParaPDF.categoria}\n` +
                    `⏱️ *Tiempo estimado:* ${datosParaPDF.tiempoEstimado || "Por confirmar con asesor"}\n\n` +
                    `📋 *Siguiente paso — Anticipo:*\n` +
                    `Para iniciar producción requerimos un *anticipo del 50%* del total cotizado.\n\n` +
                    `💳 *Formas de pago:*\n` +
                    `• Transferencia SPEI\n` +
                    `• Depósito OXXO\n` +
                    `• Efectivo en punto de entrega\n\n` +
                    `Tu número de pedido está en el siguiente mensaje para copiarlo fácilmente 👇`,
                );
                await delay(500);
                await enviarMensaje(numeroCliente, ticketFinal); // 👈 ticket solo
                await delay(1500);
                await enviarBotones(
                  numeroCliente,
                  "¿Tienes alguna duda sobre tu pedido?",
                  [
                    {
                      type: "reply",
                      reply: {
                        id: `CANCEL_${datosParaPDF?.ticket}`,
                        title: "Cancelar Pedido",
                      },
                    },
                    "Hablar con Asesor",
                    "Inicio",
                  ],
                );

                // Enviar calificación después de 4 segundos
                await delay(4000);
                await enviarBotones(
                  numeroCliente,
                  `⭐ *¿Cómo calificarías tu experiencia hoy?*\n\n` +
                    `Tu opinión nos ayuda a mejorar el servicio. ¡Solo toma un segundo! 😊`,
                  [
                    "⭐⭐⭐⭐⭐ Excelente",
                    "⭐⭐⭐ Regular",
                    "Tengo un problema",
                  ],
                );

                // 🎟️ Si usó cupón, eliminarlo y activar enfriamiento 30 días
                if (datosParaPDF.cuponAplicado) {
                  await redis.del(`cupon:${numeroCliente}`);
                  await redis.set(`cupon:usado:${numeroCliente}`, "1", {
                    ex: 60 * 60 * 24 * 30,
                  });
                  console.log(`🎟️ Cupón canjeado. Enfriamiento activado.`);
                }
                // Guardar ultimoTicket para la calificación (expira en 5 minutos)
                await setEstado(numeroCliente, { ultimoTicket: ticketFinal });
              } catch (error) {
                console.error("❌ Error en Confirmar Pedido:", error);
              }
            }
            break;

          case "Aplicar Cupón 20%":
            const estadoCupon = await getEstado(numeroCliente);
            const codigoActivo = await redis.get(`cupon:${numeroCliente}`);

            if (estadoCupon && codigoActivo) {
              const matchPrecio = (estadoCupon.precioTotal || "").match(
                /\$(\d+(\.\d+)?)/,
              );

              if (matchPrecio) {
                const precioOriginal = parseFloat(matchPrecio[1]);
                const precioConDescuento = Math.round(precioOriginal * 0.8);
                const precioFinalCupon = `$${precioConDescuento} MXN (${estadoCupon.cantidad} pzs — 20% descuento VIP ✅)`;

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
                    `🎟️ *Descuento VIP 20%:* -$${Math.round(precioOriginal * 0.2)} MXN\n` +
                    `💰 *Total final:* $${precioConDescuento} MXN\n\n` +
                    `¿Confirmamos tu pedido?`,
                  ["Confirmar Pedido", "Hablar con Asesor"],
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
                    `Al ser cotización, el asesor aplicará el 20% al validar el precio final.`,
                  ["Confirmar Pedido", "Hablar con Asesor"],
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
              ["Confirmar Pedido", "Hablar con Asesor"],
            );
            break;

          case "⭐⭐⭐⭐⭐ Excelente":
            await enviarMensaje(
              numeroCliente,
              `🌟 *¡Gracias por tu calificación!*\n\n` +
                `Nos alegra mucho saber que tuviste una excelente experiencia. ` +
                `Tu confianza es lo que nos motiva a seguir mejorando cada día. ❤️\n\n` +
                `No olvides seguirnos en redes:\n` +
                `📸 Instagram: @lyn_shop1\n` +
                `👍 Facebook: facebook.com/lyn_shopp.39`,
            );
            await delay(1000);
            await enviarBotones(
              numeroCliente,
              `¿Te gustaría hacer otro pedido?`,
              ["Nuevo Pedido", "Inicio"],
            );

            // Guardar calificación en Sheets
            try {
              const estadoCalif = await getEstado(numeroCliente);
              const ticketCalif = estadoCalif?.ultimoTicket;
              if (ticketCalif) {
                await actualizarCalificacionCRM(
                  ticketCalif,
                  "⭐⭐⭐⭐⭐ Excelente",
                );
              }
            } catch (e) {
              console.log("Error guardando calificación:", e.message);
            }
            break;

          case "⭐⭐⭐ Regular":
            await enviarBotones(
              numeroCliente,
              `🙏 *Gracias por tu honestidad.*\n\n` +
                `Queremos mejorar tu experiencia. ¿Podrías contarnos qué podríamos hacer mejor? ` +
                `Tu comentario es muy importante para nosotros.`,
              ["Hablar con Asesor"],
            );
            await enviarMensaje(
              MI_NUMERO,
              `⚠️ *CALIFICACIÓN REGULAR*\n` +
                `📱 Cliente: wa.me/${numeroCliente}\n` +
                `_El cliente dejó calificación de 3 estrellas. Revisar experiencia._`,
            );

            try {
              const estadoCalif = await getEstado(numeroCliente);
              const ticketCalif = estadoCalif?.ultimoTicket;
              if (ticketCalif) {
                await actualizarCalificacionCRM(ticketCalif, "⭐⭐⭐ Regular");
              }
            } catch (e) {
              console.log("Error guardando calificación:", e.message);
            }
            break;

          case "Tengo un problema":
            await enviarMensaje(
              numeroCliente,
              `😟 *Lamentamos escuchar eso.*\n\n` +
                `He notificado a un asesor para que te contacte a la brevedad y resuelva tu situación. ` +
                `¡Gracias por avisarnos, lo resolveremos!`,
            );
            await enviarMensaje(
              MI_NUMERO,
              `🚨 *PROBLEMA CON PEDIDO*\n` +
                `📱 Cliente: wa.me/${numeroCliente}\n` +
                `_El cliente reportó un problema después de confirmar su pedido. Atender urgente._`,
            );

            try {
              const estadoCalif = await getEstado(numeroCliente);
              const ticketCalif = estadoCalif?.ultimoTicket;
              if (ticketCalif) {
                await actualizarCalificacionCRM(
                  ticketCalif,
                  "🚨 Problema reportado",
                );
              }
            } catch (e) {
              console.log("Error guardando calificación:", e.message);
            }
            break;

          case "Mis Pedidos":
            const resultadoMisPedidos =
              await consultarHistorialCRM(numeroCliente);
            if (!resultadoMisPedidos) {
              await enviarBotones(
                numeroCliente,
                `Aún no tienes pedidos registrados. ¿Iniciamos uno? 🚀`,
                ["Personalizar", "Catalogo", "Inicio"],
              );
            } else {
              await enviarMensaje(numeroCliente, resultadoMisPedidos.resumen);
              await delay(800);
              await enviarBotones(numeroCliente, `¿Qué deseas hacer?`, [
                "Nuevo Pedido",
                "Hablar con Asesor",
                "Inicio",
              ]);
            }
            break;

          case "Ayuda":
            const estadoAyuda = await getEstado(numeroCliente);
            await enviarMensaje(
              numeroCliente,
              "🫱🏼‍🫲🏼 *No te preocupes.* Aquí te explico cómo continuar:\n\n" +
                "1️⃣ Si ya enviaste tu diseño presiona *Confirmar Pedido*\n\n" +
                "2️⃣ Para agregar detalles escríbelos aquí directamente\n\n" +
                "3️⃣ Para hablar con una persona presiona *Hablar con Asesor*\n\n" +
                "4️⃣ Para cancelar y empezar de nuevo presiona *Cancelar Pedido*",
            );
            await delay(800);
            if (estadoAyuda?.ticket) {
              await enviarBotones(numeroCliente, "¿Qué deseas hacer?", [
                "Confirmar Pedido",
                {
                  type: "reply",
                  reply: {
                    id: `CANCEL_${estadoAyuda.ticket}`,
                    title: "Cancelar Pedido",
                  },
                },
                "Hablar con Asesor",
              ]);
            } else {
              await enviarBotones(numeroCliente, "¿Qué deseas hacer?", [
                "Confirmar Pedido",
                "Hablar con Asesor",
                "Inicio",
              ]);
            }
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
          `Lo siento *${nombreCliente}*, por ahora solo proceso imágenes como referencias de diseño. 🖨️\n\nEnvíame una foto o imagen de referencia de tu proyecto.`,
        );
      }
    } catch (err) {
      console.error("❌ Error procesando flujo:", err.message);
      console.error("❌ Stack completo:", err.stack);
      console.error("❌ Tipo de error:", err.name);
    }
  }
});

// ==========================================
// 4. INICIO DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3005;
// ==========================================
// RECORDATORIO AUTOMÁTICO DE ANTICIPO
// ==========================================
setInterval(
  async () => {
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

      const ahora = new Date();

      for (const fila of filas) {
        const estadoPago = fila.get("Estado_Pago") || "";
        const estadoAnticipo = fila.get("Estado_Anticipo") || "";
        const fechaStr = fila.get("Fecha") || "";
        const whatsapp = fila.get("Whatsapp") || "";
        const ticket = fila.get("Ticket") || "";
        const recordatorioEnviado = fila.get("Recordatorio") || "";

        // Solo pedidos pendientes de pago sin recordatorio enviado
        if (
          estadoPago === "Pendiente" &&
          estadoAnticipo === "Pendiente" &&
          recordatorioEnviado !== "Enviado" &&
          whatsapp &&
          ticket
        ) {
          try {
            const partes = fechaStr.split(",")[0].trim().split("/");
            const fechaPedido =
              partes.length === 3
                ? new Date(`${partes[2]}-${partes[1]}-${partes[0]}`)
                : new Date(fechaStr);

            const horasTranscurridas = (ahora - fechaPedido) / (1000 * 60 * 60);

            if (horasTranscurridas >= 24 && horasTranscurridas < 48) {
              const numeroWA = whatsapp
                .replace("wa.me/", "")
                .replace(/\D/g, "");
              if (numeroWA.length >= 10) {
                await enviarMensaje(
                  numeroWA,
                  `👋 *¡Hola!* Te escribimos de *J-3D Axis Studio*.\n\n` +
                    `Tu pedido *\`${ticket}\`* está listo para iniciar producción.\n\n` +
                    `Recuerda que necesitamos el *anticipo del 50%* para comenzar. ` +
                    `Si ya realizaste el pago, ignora este mensaje o escríbenos.\n\n` +
                    `¿Tienes alguna duda? Estamos aquí. ✨`,
                );
                // Marcar recordatorio como enviado
                fila.set("Recordatorio", "Enviado");
                await fila.save();
                console.log(`📨 Recordatorio enviado para ticket: ${ticket}`);
              }
            }
          } catch (e) {
            console.log(
              `Error procesando recordatorio para ${ticket}:`,
              e.message,
            );
          }
        }
      }
    } catch (e) {
      console.log("Error en recordatorio automático:", e.message);
    }
  },
  60 * 60 * 1000,
); // Revisar cada hora
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
});
