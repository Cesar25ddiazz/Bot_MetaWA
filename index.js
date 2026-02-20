require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
const fs = require("fs-extra");
const path = require("path");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

//Función de horario
function estaFueraDeHorario() {
  const ahora = new Date();
  const utc = ahora.getTime() + ahora.getTimezoneOffset() * 60000;
  const horaMexico = new Date(utc + 3600000 * -6);

  const dia = horaMexico.getDay();
  const hora = horaMexico.getHours();
  return dia === 0 || dia === 6 || hora >= 23 || hora < 10;
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
    const botones = listaBotones.slice(0, 3).map((nombre, i) => ({
      type: "reply",
      reply: { id: `btn_${i}`, title: nombre.substring(0, 20) },
    }));
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

    await sheet.addRow({
      Fecha: hoy.toLocaleString ("es-MX", {
        timeZone: "America/Mexico_City",
      }),
      Ticket: datos.ticket,
      Cliente: datos.nombre,
      Whatsapp: `wa.me/${datos.numero}`,
      Producto: datos.categoria || "📦 GENERAL",
      Descripcion: datos.notas,
      Link_Imagen: datos.urlImagen,
      Estado_Produccion: "En Cola",
      Estado_Pago: "Pendiente",
      Total_a_Pagar: datos.precio,
      Fecha_Entrega: entrega.toLocaleDateString("es-MX")
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
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const filas = await sheet.getRows();

    //Busca la fila que coincida con el ticket
    const fila = filas.find(f => f.get('Ticket') === ticket);

    if (fila) {
      if (nuevosDatos.Estado_Pago) fila.set('Estado_Pago', nuevosDatos.Estado_Pago);
      if (nuevosDatos.Estado_Produccion) fila.set('Estado_Produccion', nuevosDatos.Estado_Produccion);
      await fila.save(); //Guarda los cambios en la nube
    }
  }catch (error) {
    console.error("Error en actualizar el CRM:", error);
  }
}

async function consultarStatusCRM(ticket) {
  try {
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const filas = await sheet.getRows();

    //Busca la fila que coincida con el ticket
    const fila = filas.find(f => f.get('Ticket') === ticket);
    
    if (!fila) {
      return `No encontre ningun pedido con el ticket *${ticket}*. Por favor, verifica que esté bien escrito.`;
    }

    //Estraer datos de la fila
    const produccion = fila.get('Estado_Produccion') || "Pendiente";
    const pago = fila.get('Estado_Pago') || "Pendiente";
    const entrega = fila.get('Fecha_Entrega') || "Por definir";

    return `🔎 *Estado de tu Pedido:* ${ticket}\n\n` +
    `🛠️ *Producción:* ${produccion}\n` +
    `💰 *Pago:* ${pago}\n` +
    `📅 *Fecha estimada de entrega:* ${entrega}\n\n` +
    `Si tienes dudas, un asesor te puede ayudar.`;
  }catch (error) {
    console.error("Error al consultar status:", error);
    return "Hubo un error al consultar el sistema. Intentalo mas tarde.";
  }
}

// Obtener la URL de descarga de una imagen desde Meta
async function procesarPedidoDetallado(
  nombreCliente,
  numeroCliente,
  imageId,
  comentario,
  ticket
) {
  try {
    const fechaHora = new Date().toLocaleString("es-MX", {
      timeZone: "America/Mexico_City",
    });
    console.log("Iniciando proceso de imagen para:", ticket);
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
    else if (cat === "☕ TAZA") precioUnitario = Number(PRECIOS.taza_personalizada);
    else if (cat === "🏷️ ETIQUETAS") precioUnitario = Number(PRECIOS.etiquetas);
    else if (cat === "🧢 GORRA") precioUnitario = Number(PRECIOS.gorra);

    
    //Intenta detectar cantidad
    const numerosEnTexto = comentario.match(/\d+/);
    let cantidadDetectada = numerosEnTexto ? parseInt(numerosEnTexto[0]) : 1; //Si no se encuentra asume 1
    
    //Logica para etiquetas
    let totalFinal = 0;
    let precioBase = Number(PRECIOS.etiquetas);

    if (cat,includes("ETIQUETAS")) {
      //Si piden 200, nos dividimos entre 100 = 2 unidades de precio
      //Usamos match.ceil para redondear hacia arriba si pide 150 cobra 2 paquetes 
      totalFinal = (cantidadDetectada / 100) * precioBase;
    }else {
      totalFinal = Number(precioUnitario) * cantidadDetectada;
    }
    totalFinal = Math.round(totalFinal * 100) / 100;

    //Calculo total
    let textoPresupuesto = cat.includes("MDF") ? "Sujeto a cotizacion segun diseño" : `$${totalFinal} MXN (${cantidadDetectada} pzs)`;

    //Guardar en CRM
    await guardarEnCRM({
      ticket: ticket,
      nombre: nombreCliente,
      numero: numeroCliente,
      categoria: cat,
      notas: comentario,
      urlImagen: urlPermanente,
      precio: cat === "🪵 MDF" ? "Cotizacion" : totalFinal.toString() //Se guarda el total en la columna
    });

    //Notidicacion detallada
    const mensajeAdmin =
      `🛠️ *Orden de Producción:* 🛠️\n` +
      `-----------------------------\n` +
      `🆔 *Ticket:* ${ticket}\n` +
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
      `Estimado cliente, su solicitud ha sido enviada a nuestro taller.\n` +
      `Estamos trabajando para que su proyecto sea único.\n\n` +
      `🕐 *Tiempo de respuesta:* 15 a 30 minutos.\n\n` +
      `¡Gracias por su preferencia! ✨ \n\n` +
      `¿Desea realizar alguna otra consulta o prefiere hablar con un *Asesor Especializado*?`;

    await delay(1500);
    await enviarBotones(numeroCliente, despedidaElegante, [
      "Hablar con Asesor",
      "Nuevo Pedido",
      "Inicio",
    ]);
  } catch (error) {
    console.error("✖️ Error en producción:", error);
  }
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
    if (ahora - timestampMsg > 120) {
      console.log("⚠️ Ignorando mensaje antiguo/reintento");
      return;
    }
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
        //Verificamos si ya esta procesando a el cliente para no repetir
        if (estadosClientes[numeroCliente]?.esperandoNombre) return;
        const ticket = `PED-${Date.now()}`;
        const comentario = msg.image.caption || "Sin notas";
        const imageId = msg.image.id;

        //Guardamos el estado donde le cliente manda su foto y esperamos su nombre
        estadosClientes[numeroCliente] = {
          esperandoNombre: true,
          ticket,
          imageId,
          comentario,
        };

        //Confirmación inmediata del cliente
        await enviarMensaje(numeroCliente, `📸 *Imagen recibida con éxito*`);
        await delay(1000);

        //Preguntamos el nombre para el registro
        await enviarMensaje(
          numeroCliente,
          `Para registrar tu orden *${ticket}*, ¿Podrías poner tu *Nombre Completo*? ✨`,
        );
      }

      // B. SI ENVÍAN TEXTO
      else if (msg.type === "text") {
        //Limpiamos el texto del cliente
        const textoCliente = msg.text.body.toLowerCase().trim();
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

        if (estadosClientes[numeroCliente]?.esperandoNombre) {
          const datos = estadosClientes[numeroCliente];

          //Procesamos con el nombre real que acaba de escribir
          await procesarPedidoDetallado(
            textoCliente,
            numeroCliente,
            datos.imageId,
            datos.comentario,
            datos.ticket,
          );

          //Limpiamos el estado para que pueda seguir usando el bot normal
          delete estadosClientes[numeroCliente];
          return; //Salimos para que no ejecute la lógica de bienvenida
        }

        if (quiereBienvenida) {
          // await escribir(numeroCliente); //El cliente ve escribiendo
          //await delay(1500);
          await enviarBotones(
            numeroCliente,
            `Hola buen dia ${nombreCliente} Bienvenido a nuestra tienda ¿En que podemos apoyarte hoy?`,
            ["Catalogo", "Precios", "Personalizar"],
          );
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
        } else {
          //await escribir(numeroCliente); //El cliente ve escribiendo
          //await delay(1500);
          const ayuda = "No estoy seguro de ayudarte con eso. 😅 \n"
          await enviarBotones(
            numeroCliente, ayuda,
            ["Inicio", "Catalogo", "Personalizar"]
          );
        }

        if (textoCliente.startsWith("pagado ")) {
  const ticketBusqueda = textoCliente.split("")[1].toUpperCase();
if (ticketBusqueda) {
   await actualizarEstadoCRM(ticketBusqueda, {Estado_Pago: "Pagado"});
  await enviarMensaje(numeroCliente, `El ticket *${ticketBusqueda}* ha sido marcado como PAGADO en el CRM.`);
}
}

if (textoCliente.startsWith("estatus ")  || textoCliente.startsWith("ped-")){
  let ticketBusqueda = textoCliente.includes("estatus ") ? textoCliente.split("")[1]?.toUpperCase() : textoCliente.toUpperCase();
  if (ticketBusqueda) {
    console.log("Buscando ticket", ticketBusqueda)
   const resultado = await consultarStatusCRM(ticketBusqueda);
  await enviarMensaje(numeroCliente, resultado); 
  }
}
      }

      // C. SI ENVÍAN BOTONES
      else if (msg.type === "interactive") {
        const resBtn = msg.interactive.button_reply?.title;

        if (!resBtn) return; //Si por algo viene vacío, salimos para evitar errores
        console.log(`El cliente presiono: ${resBtn}`);

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
              "https://i.postimg.cc/PfFWcjG7/6e514668-b37d-4302-85d2-1153da9afe73.jpg";
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
            const instrucciones = "🎨 *Área de Personalización*\n\n" +
            "Selecciona una Categoría para realizar un *Nuevo Pedido*.\n\n" +
            "-----------------------------\n" +
            "🔎 Si ya tienes un pedido y quieres saber su estatus escribe:\n\n" +
            "*Estatus* seguido de tu ticket (ej: *Estatus PED-1234*)";
            await enviarBotones(
              numeroCliente, instrucciones,
              ["Textil", "Tazas y MDF", "Etiquetas"],
            );
            break;

          case "Textil":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            await enviarMensaje(
              numeroCliente,
              "👕 *Linea textil (Playeras, Sudaderas y calcetas)*\n\n1. Envía la imagen de tu diseño.\n2. En la descripción escribe: *Talla, Color y que tipo deprenda se estampara*.",
            );
            break;

          case "Tazas y MDF":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
            await enviarMensaje(
              numeroCliente,
              "☕*Tazas y madera MDF*🪵\n\nEnvía tu imagen o diseño especificando tus instrucciones en:\n- Taza Personalizada\n- Grabado/Corte láser en MDF",
            );
            break;

          case "Etiquetas":
            //await escribir(numeroCliente); //El cliente ve escribiendo
            //await delay(1500);
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
