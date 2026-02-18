require('dotenv').config();
const express = require("express");
const axios = require("axios");
const cloudinary = require('cloudinary').v2;
const fs = require("fs-extra");
const path = require("path");


//Funcion de horario
function estaFueraDeHorario() {
  const ahora = new Date();
  const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
  const horaMexico = new Date(utc + (3600000 * -6));

  const dia = horaMexico.getDay();
  const hora = horaMexico.getHours();
  return dia === 0 || dia === 6 || hora >= 22 || hora < 9;
}

//Funcion retraso 
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
const PHONE_NUMBER_ID =
process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = 
process.env.ACCESS_TOKEN;
const WEBHOOK_TOKEN =
process.env.WEBHOOK_TOKEN;
const MI_NUMERO =
process.env.MY_PERSONAL_NUMBER;
const estadosClientes = {};

//Configuracion de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const BASE_PATH = path.join(__dirname, "pedidos_clientes");
fs.ensureDirSync(BASE_PATH); // Crea la carpeta principal si no existe

const PRECIOS = {
  playera_basica: "250",
  sudadera: "450",
  gorra: "180",
  taza_personalizada: "85",
  etiquetas: "260",
  mdf: "Cotizacion segun diseño",
  personalizacion_extra: "150"
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
async function enviarPDF(numero, url, nombreArchivo){
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            headers: {"Authorization": `Bearer ${ACCESS_TOKEN}`},
            data: {
                messaging_product: "whatsapp",
                to: numero,
                type: "document",
                document: {
                    link: url,
                    filename: nombreArchivo
                }
            }
        });
    } catch (error) {
        console.error("Error enviado de PDF", error.response?.data || error.message);
    }
}

// Obtener la URL de descarga de una imagen desde Meta
async function procesarPedidoDetallado(nombreCliente, numeroCliente, imageId, comentario, ticket) {
  try {
    const fechaHora = new Date().toLocaleString("es-MX", {timeZone: "America/Mexico_City"});
    console.log("Iniciando proceso de imagen para:", ticket);
    const responseMeta = await axios.get(`https://graph.facebook.com/v18.0/${imageId}`, 
      {headers: {'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`} 
    });
    const urlDescarga = responseMeta.data.url;

    //Descarga de imagen como buffer
    const imagenResponse = await axios.get(urlDescarga, {
      headers: {'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`},
      responseType: 'arraybuffer'
    });

    //Convertir en formato Base64 para cloudinary
    const base64Image = `data:image/jpeg;base64,${Buffer.from(imagenResponse.data).toString('base64')}`;

    //SUbir a cloudinary
    const result = await cloudinary.uploader.upload(base64Image, {folder: "SISTEMA_PRODUCCION", public_id: ticket, resource_type: "image"});
    const urlPermanente = result.secure_url;
    console.log("Imagen en cloudinary:", urlPermanente);

    // Determinar categoria para la notificacion
    let cat = "📦 GENERAL";
    const c = comentario.toLowerCase();
    if (c.includes("taza")) cat = "☕ TAZA";
    else if (c.includes("mdf")) cat = "🪵 MDF";
    else if (c.includes("etiqueta")) cat = "🏷️ ETIQUETAS";
    else if (c.includes("playera") || c.includes("sudadera")) cat = "👕 TEXTIL";

    //Notidicacion detallada
    const mensajeAdmin = 
    `🛠️ *Orden de Produccion:* 🛠️\n` +
    `-----------------------------\n` +
    `🆔 *Ticket:* ${ticket}\n` + 
    `👤 *Cliente:* ${nombreCliente}\n` + 
    `📱 *Whatsapp:* wa.me/${numeroCliente}\n` + 
    `📝 *Notas:* ${comentario}\n` + 
    `🖼️ *Link:* ${result.secure_url}\n` +
    `-----------------------------\n` +
    `⏰ ${fechaHora}`;
    await enviarMensaje(MI_NUMERO, mensajeAdmin);

    const despedidaElegante = `✅ *¡Orden registrada con exito!*\n\n` +
  `Estimado cliente, su solicitud ha sido enviada a nuestro taller de diseño.\n` +
  `Estamos trabajando para que su proyecto sea unico.\n\n` +
  `🕐 *Tiempo de respuesta:* 15 a 30 minutos.\n\n` +
  `¡Gracias por su preferencia! ✨ \n\n` +
  `¿Desea realizar alguna otra consulta o prefiere hablar con un *Asesor Especializado*?`;

  await delay(1500);
  await enviarBotones(numeroCliente, despedidaElegante, ["Hablar con Asesor", "Nuevo Pedido", "Inicio"]);

  } catch (error) {
    console.error("✖️ Error en produccion:", error);
  }
}

async function marcarComoLeido(messageId) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_Id: messageId
      },
      {
        headers: {Authorization: `Bearer ${process.env.ACCESS_TOKEN}`}
      }
    );
    console.log("✅ Check azul enviado para:", messageId);
  }catch (error) {
    console.error("Error al marcar como leido:", error.response?.data || error.message);
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
  res.sendStatus(200);

  const body = req.body;
  const entry = body.entry?.[0]?.changes?.[0]?.value;

  if (entry?.messages?.[0]) {
    const msg = entry.messages[0];
    await marcarComoLeido(msg.id);
    const numeroCliente = msg.from;
    const nombreCliente = (
      entry.contacts?.[0]?.profile?.name || "Cliente").replace(/\s+/g, "_");

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
          `Hola ${nombreCliente} Estamos fuera de horaio  (Lunes a Viernes de 9am-8pm). Puedes enviarnos tu diseño de una vez y lo revisaremos.`,
        );
        return;
      }
    }

    try {
      // A. SI ENVÍAN UNA IMAGEN (Lo que sí procesamos)
      if (msg.type === "image") {
        const ticket = `PED-${Date.now()}`;
        const comentario = msg.image.caption || "Sin notas";
        const imageId = msg.image.id;

        //Guardamos el estado donde le cliente manda su foto y esperamos su nombre
        estadosClientes[numeroCliente] = {esperandoNombre: true, ticket, imageId, comentario};

        //Confirmacion inmediata del cliente 
        await enviarMensaje(numeroCliente, `📸 *Imagen recibida con exito*`);
        await delay(1000);

        //Preguntamos el nombre para el registro
        await enviarMensaje(numeroCliente, `Para registrar tu orden *${ticket}*, ¿Podrias poner tu *Nombre Completo*? ✨`);

      }

      // B. SI ENVÍAN TEXTO
      else if (msg.type === "text") {
        //Limpiamos el texto del cliente
       const textoCliente = msg.text.body.toLowerCase().trim();
        // Definimos una lista de palabras que activan la bienvenida
        const disparadoresBienvenida = ["hola", "buenos dias", "buenas tardes", "buenas noches", "hey", "que tal"];
        // Se verifica si una de estas palabras esta dentro de lo que escribio el cliente
        const quiereBienvenida = disparadoresBienvenida.some(palabra => textoCliente.includes(palabra));

        if (estadosClientes[numeroCliente]?.esperandoNombre) {
          const datos = estadosClientes[numeroCliente];

          //Procesamos con el nombre real que acaba de escribir
          await procesarPedidoDetallado(textoCliente, numeroCliente, datos.imageId, datos.comentario, datos.ticket);

          //Limpiamos el estado para que pueda seguir usando el bot normal
          delete estadosClientes[numeroCliente];
          return; //Salimos para que no ejecute la logica de bienvenida 
        }

        if (quiereBienvenida) {
            await enviarBotones(numeroCliente, `Hola buen dia ${nombreCliente} Bienvenido a nuestra tienda ¿En que podemos apoyarte hoy?`,
                ["Catalogo", "Precios", "Personalizar"]);
        } 

        //Nueva respuesta de precios
        else if (
          textoCliente.includes("precios") ||
          textoCliente.includes("cuanto") ||
          textoCliente.includes("costo") ||
          textoCliente.includes("cotización")
        ) {
          const mensajePrecios =
            `💰 *Lista de Precios actualizada* 💰\n\n` +
            `👕 *Playera personalizada:* ${PRECIOS.playera_basica}\n` +
            `🧥 *Sudadera con Diseño:* ${PRECIOS.sudadera}\n` +
            `🧢 *Gorra estampada:* ${PRECIOS.gorra}\n` +
            `✨ *Diseño extra:* ${PRECIOS.personalizacion_extra}\n\n` +
            `_Precios sujetos a cambios segun la complejidad del diseño._\n\n` +
            `¿Te gustaria iniciar un pedido ahora? Presiona el boton *Personalizar*.`;

          await enviarBotones(numeroCliente, mensajePrecios, [
            "Personalizar",
            "Tallas",
          ]);
        } 
        
        else if (textoCliente.includes("catalogo")) {
            const urlPdf = "https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf";
            await enviarPDF(numeroCliente, urlPdf, "Catalogo_Tienda.pdf");
            await delay(3000);
            await enviarBotones(numeroCliente, "Ahi tienes el catalogo. ¿Deseas algo mas?", ["Tallas", "Personalizar"]);
        }
        else {
          await enviarBotones(
            numeroCliente,
            "No estoy seguro de entender eso, pero aqui esta el menu para apoyarte:", ["Inicio", "Catalogo"]);
        }
      }

      // C. SI ENVÍAN BOTONES
      else if (msg.type === "interactive") {
        const resBtn = msg.interactive.button_reply?.title;

        if (!resBtn) return; //Si por algo viene vacio, salimos para evitar errores
        console.log(`El cliente presiono: ${resBtn}`);

        switch (resBtn){
          case "Inicio":
          case "Hola":
          case "Menu":
            await enviarBotones(numeroCliente, "🏠 *Menu Principal*\nBienvenido a nuestro centro de atencion. ¿Que deseas consultar?", ["Catalogo", "Precios", "Personalizar"]);
            break;

            case "Catalogo":await enviarMensaje(numeroCliente, "📂 *Nuestros Catalogos*\n\n👕 *Textil:* [https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf]\n☕ *Tazas y Regalos:* [https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf]\n🪵 *Grabado y Corte MDF* [https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf]\n\n_Echa un vistazo y cuando estes listo presiona 'Personalizar'_");
            await delay(2000);
            await enviarBotones(numeroCliente, "¿Te gustaria ver los precios o ya prefieres personalizar?", ["Precios", "Personalizar", "Inicio"]);
            break;
            case "Precios":
              const listaPrecios = `💰 *Lista de Nuestros Precios:*
            👕 Playera: ${PRECIOS.playera_basica}
            🧥 Sudadera: ${PRECIOS.sudadera}
            🧢 Gorra: ${PRECIOS.gorra}
            ☕ Taza Personalizada: ${PRECIOS.taza_personalizada}
            🏷️ Etiquetas (100 pzas): ${PRECIOS.etiquetas}
            🪵 MDF: ${PRECIOS.mdf}
            ✨ Extra: ${PRECIOS.personalizacion_extra}
            _Precios sujetos a cambios o segun la complejidad_`;
        await enviarMensaje(numeroCliente, listaPrecios);
        await delay(2000);
        await enviarBotones(numeroCliente, "¿Deseas ver las tallas o empezar tu pedido?", ["Tallas", "Personalizar", "Inicio"]);
        break;

        case "Tallas":
          const urlTabla = "https://i.postimg.cc/PfFWcjG7/6e514668-b37d-4302-85d2-1153da9afe73.jpg";
          await enviarImagen(numeroCliente, urlTabla, "📏 *Guia de Medidas*\nAqui tienes las tallas para nuestras prendas textiles");
          await delay(3000);
          await enviarBotones(numeroCliente, "¿Deseas regresar al menu o ir a personalizar?", ["Inicio", "Personalizar"]);
          break;

          case "Personalizar":
            //Menu de los servicios
            await enviarBotones(numeroCliente, "🎨 *Centro de Personalizacion*\n ¿En que tipo de producto te gustaria trabajar hoy?", 
              ["Textil", "Tazas y MDF", "Etiquetas"]);
            break;

          case "Textil":
              await enviarMensaje(numeroCliente, 
                "👕 *Linea textil (Playeras, Sudaderas y calcetas)*\n\n1. Envia la imagen de tu diseño.\n2. En la descripcion escribe: *Talla, Color y que tipo deprenda se estampara*.");
                break;

          case "Tazas y MDF":
              await enviarMensaje(numeroCliente, "☕*Tazas y madera MDF*🪵\n\nEnvia tu imagen o diseño especificando tus instrucciones en:\n- Taza Personalizada\n- Grabado/Corte laser en MDF");
              break;

          case "Etiquetas":
            await enviarMensaje(numeroCliente, "🏷️ *Etiquetas*\nEnvia tu logo y menciona las *medidas* y la *cantidad* que necesitas.");
            break;

          case "Inicio":
            await enviarBotones(numeroCliente, "Menu principal 🏠\n Selecciona una opcion:", ["Catalogo", "Precios", "Personalizar"]);
            break;

          case "Hablar con Asesor":
            await enviarMensaje(numeroCliente, "🫱🏼‍🫲🏼 *Conectando con un especialista...*\n\nHe notificado a nuestro equipo especializado. En un momento uno de nuestros asesores tomara la conversacion para una atencion personalizada. ¡Gracias por tu paciencia.!");
            //Notificacion para mi
            await enviarMensaje(MI_NUMERO, `⚠️ *ATENCION HUMANA:* El cliente wa.me/${numeroCliente} solicita un asesor especializado.`);
            break;

          case "Nuevo Pedido":
            await enviarBotones(numeroCliente, "¡Perfecto! vamos a crear algo nuevo. ¿Que producto te interesa?", ["Textil", "Tazas y MDF", "Etiquetas"]);
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
const PORT = 
process.env.PORT || 3005;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
});
