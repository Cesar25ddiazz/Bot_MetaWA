require('dotenv').config();

const express = require("express");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

//Funcion de horario
function estaFueraDeHorario() {
  const ahora = new Date();
  const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
  const horaMexico = new Date(utc + (3600000 * -6));

  const dia = horaMexico.getDay();
  const hora = horaMexico.getHours();
  return dia === 0 || dia === 6 || hora >= 21 || hora < 9;
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
// 1. CONFIGURACIÓN
// ==========================================
const PHONE_NUMBER_ID =
process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = 
process.env.ACCESS_TOKEN;
const WEBHOOK_TOKEN =
process.env.WEBHOOK_TOKEN;
const BASE_PATH = path.join(__dirname, "pedidos_clientes");
fs.ensureDirSync(BASE_PATH); // Crea la carpeta principal si no existe

const PRECIOS = {
  playera_basica: "250",
  sudadera: "450",
  gorra: "180",
  personalizacion_extra: "150",
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
async function obtenerUrlImagen(id) {
  try {
    const response = await axios({
      method: "GET",
      url: `https://graph.facebook.com/v18.0/${id}`,
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    return response.data.url;
  } catch (e) {
    console.error("❌ Error obtenerUrlImagen:", e.message);
    return null;
  }
}

// Descargar imagen y guardarla en carpeta del cliente
async function descargarImagen(url, nombreCliente, telefono, imageId) {
  try {
    const folderPath = path.join(BASE_PATH, `${nombreCliente}_${telefono}`);
    await fs.ensureDir(folderPath);
    const filePath = path.join(folderPath, `${imageId}.jpg`);

    const response = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (e) {
    console.error("❌ Error descargarImagen:", e.message);
  }
}

// Guardar el texto que acompaña a la imagen en un .txt
async function guardarComentario(nombreCliente, telefono, imageId, comentario) {
  try {
    const folderPath = path.join(BASE_PATH, `${nombreCliente}_${telefono}`);
    const filePath = path.join(folderPath, `${imageId}.txt`);
    await fs.writeFile(filePath, `Instrucciones del cliente:\n${comentario}`);
  } catch (e) {
    console.error("❌ Error guardarComentario:", e.message);
  }
}

function generarNumeroPedido() {
  // Obtenemos la fecha actual y ajustamos a UTC-6 (México) de forma manual pero segura
  const ahora = new Date();
  const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
  // México es UTC-6
  const horaMexico = new Date(utc + (3600000 * -6));

  const anio = horaMexico.getFullYear();
  const mes = String(horaMexico.getMonth() + 1).padStart(2, '0');
  const dia = String(horaMexico.getDate()).padStart(2, '0');
  const horas = String(horaMexico.getHours()).padStart(2, '0');
  const minutos = String(horaMexico.getMinutes()).padStart(2, '0');

  const fechaFormateada = `${anio}${mes}${dia}`;
  const horaFormateada = `${horas}${minutos}`;

  return `PED-${fechaFormateada}-${horaFormateada}`;
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
        const imageId = msg.image.id;
        const comentario = msg.image.caption || "Sin instrucciones";
        const ticket = generarNumeroPedido(); //Generamos el ID unico
        console.log(`Procesando Pedido ${ticket} de: ${nombreCliente}`);
        const imageUrl = await obtenerUrlImagen(imageId);
        if (imageUrl) {
          await descargarImagen(
            imageUrl,
            nombreCliente,
            numeroCliente,
            imageId,
          );
          //Se guarda el comentario incluyendo el numero de pedido
          const textoAGuardar = `Orden: ${ticket}\nCliente: ${nombreCliente}\nTel: ${numeroCliente}\nInstrucciones: ${comentario}`;
          await guardarComentario(
            nombreCliente,
            numeroCliente,
            imageId,
            textoAGuardar,
          );

          //Respondemos al cliente con su numero
          await enviarMensaje(
            numeroCliente,
            `✅ *¡Pedido Confirmado!*\n\n` +
              `🆔 *Orden:* ${ticket}\n` +
              `👤 *Cliente:* ${nombreCliente}\n` +
              `📝 *Notas:* ${comentario}\n\n` +
              `He guardado tu diseño. Nos pondremos en contacto contigo pronto para finalizar los detalles del pago y envio.`,
          );
        }
      }

      // B. SI ENVÍAN TEXTO
      else if (msg.type === "text") {
        //Limpiamos el texto del cliente
       const textoCliente = msg.text.body.toLowerCase().trim();
        // Definimos una lista de palabras que activan la bienvenida
        const disparadoresBienvenida = ["hola", "buenos dias", "buenas tardes", "buenas noches", "hey", "que tal"];
        // Se verifica si una de estas palabras esta dentro de lo que escribio el cliente
        const quiereBienvenida = disparadoresBienvenida.some(palabra => textoCliente.includes(palabra));

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
          await enviarMensaje(
            numeroCliente,
            "Si quieres ver el menú principal, escribe *Hola*.",);
        }
      }

      // C. SI ENVÍAN BOTONES
      else if (msg.type === "interactive") {
        const resBtn = msg.interactive.button_reply?.title;

        if (!resBtn) return; //Si por algo viene vacio, salimos para evitar errores
        console.log(`El cliente presiono: ${resBtn}`);

        if (resBtn === "Catalogo"){
            const urlPdf = "https://github.com/user-attachments/files/25300456/Practica.GO_Prac3_LyA.1.pdf"
            await enviarMensaje(numeroCliente, "Claro aqui tienes nuestro catalogo completo en PDF");
            await enviarPDF(numeroCliente, urlPdf, "Catalogo_Tienda.pdf")
            await delay(3000);
            //Enviamos un mensaje extra para ofrecer las tallas
            await enviarBotones(numeroCliente, "¿Desea revisar nuestra tabla de tallas o prefieres personalizar?", ["Tallas", "Personalizar"]);
        }

        if (resBtn === "Tallas") {
          //URL ejemplo de una tabla de tallas.
          //Cambiala por la URL real de tu imagen (puedes subirla a imgur o PostImages)
          const urlTabla =
            "https://i.postimg.cc/PfFWcjG7/6e514668-b37d-4302-85d2-1153da9afe73.jpg";
          await enviarImagen(
            numeroCliente,
            urlTabla,
            "Aqui Tienes nuestra tabla de medidas para playeras 📏",
          );
          await enviarBotones(numeroCliente, "¿Desea Verificar algo mas?", ["Precio", "Personalizar"]);
        } else if (resBtn === "Personalizar") {
          await enviarMensaje(
            numeroCliente,
            "¡Excelente! Enviamos el diseño del modelo y tus instrucciones",
          );
        }
       else if (resBtn === "Precios") {
        const lista = `💰 *Nuestros Precios:*
            👕 Playera: ${PRECIOS.playera_basica}
            🧥 Sudadera: ${PRECIOS.sudadera}
            🧢 Gorra: ${PRECIOS.gorra}
            ✨ Extra: ${PRECIOS.personalizacion_extra}
            _Precios sujetos a cambios_`;
        await enviarMensaje(numeroCliente, lista);
        console.log("Lista de precios enviada correctamente");
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
