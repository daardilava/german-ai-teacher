import { Agent, AgentSession, ServerOptions, cli, defineAgent, inference, llm } from '@livekit/agents';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Datos del restaurante.
// Horario y dirección: ficha de TripAdvisor de Mirador Guane (Zapatoca).
// Capacidad, última hora de reserva y tamaño máximo de grupo son supuestos
// de prueba: cámbialos por los datos reales del restaurante.
// ---------------------------------------------------------------------------
const RESTAURANTE = {
  nombre: 'Mirador Guane',
  direccion: 'Vereda Cuchilla de San Pablo, Finca El Limoncito, Zapatoca, Santander, Colombia',
  zonaHoraria: 'America/Bogota',
  diaCerrado: 2, // 0 = domingo, 1 = lunes, 2 = martes...
  apertura: '08:00',
  cierre: '20:00',
  ultimaReserva: '19:00', // supuesto: una hora antes del cierre
  capacidadPorHora: 40, // supuesto: personas por franja de una hora
  maxPersonasPorReserva: 15, // supuesto: grupos mayores necesitan atención especial
};

const ARCHIVO_RESERVAS = fileURLToPath(new URL('./reservas.json', import.meta.url));
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

type Reserva = {
  codigo: string;
  nombre: string;
  telefono: string;
  fecha: string; // AAAA-MM-DD
  hora: string; // HH:MM
  personas: number;
  notas: string;
  creada: string;
};

async function leerReservas(): Promise<Reserva[]> {
  try {
    return JSON.parse(await readFile(ARCHIVO_RESERVAS, 'utf8')) as Reserva[];
  } catch {
    return [];
  }
}

/** Fecha (AAAA-MM-DD) y hora (HH:MM) actuales en Colombia. */
function ahoraEnColombia() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: RESTAURANTE.zonaHoraria,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora: `${partes.hour}:${partes.minute}` };
}

function diaDeLaSemana(fecha: string) {
  return new Date(`${fecha}T12:00:00Z`).getUTCDay();
}

/** Devuelve un motivo en texto si la reserva no es posible, o null si sí lo es. */
async function comprobarDisponibilidad(fecha: string, hora: string, personas: number) {
  if (Number.isNaN(Date.parse(`${fecha}T00:00:00Z`))) return 'La fecha no es válida.';
  const ahora = ahoraEnColombia();
  if (fecha < ahora.fecha || (fecha === ahora.fecha && hora <= ahora.hora)) {
    return 'Esa fecha y hora ya pasaron.';
  }
  if (diaDeLaSemana(fecha) === RESTAURANTE.diaCerrado) {
    return `El restaurante cierra los ${DIAS[RESTAURANTE.diaCerrado]}.`;
  }
  if (hora < RESTAURANTE.apertura || hora > RESTAURANTE.ultimaReserva) {
    return `Solo se reserva entre las ${RESTAURANTE.apertura} y las ${RESTAURANTE.ultimaReserva}.`;
  }
  if (personas > RESTAURANTE.maxPersonasPorReserva) {
    return `Para grupos de más de ${RESTAURANTE.maxPersonasPorReserva} personas se necesita atención especial del restaurante.`;
  }
  const franja = hora.slice(0, 2);
  const ocupadas = (await leerReservas())
    .filter((r) => r.fecha === fecha && r.hora.slice(0, 2) === franja)
    .reduce((total, r) => total + r.personas, 0);
  if (ocupadas + personas > RESTAURANTE.capacidadPorHora) {
    return 'No queda cupo en esa franja horaria. Ofrece otra hora cercana.';
  }
  return null;
}

const fechaHora = {
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha de la reserva en formato AAAA-MM-DD'),
  hora: z.string().regex(/^\d{2}:\d{2}$/).describe('Hora de llegada en formato HH:MM de 24 horas'),
  personas: z.number().int().min(1).describe('Número de personas'),
};

const herramientas = {
  verificar_disponibilidad: llm.tool({
    description:
      'Comprueba si hay cupo para una fecha, hora y número de personas. Úsala antes de pedir los datos personales.',
    parameters: z.object(fechaHora),
    execute: async ({ fecha, hora, personas }) => {
      const motivo = await comprobarDisponibilidad(fecha, hora, personas);
      return motivo ? { disponible: false, motivo } : { disponible: true, dia: DIAS[diaDeLaSemana(fecha)] };
    },
  }),

  crear_reserva: llm.tool({
    description:
      'Registra la reserva. Úsala solo después de verificar la disponibilidad, tener todos los datos ' +
      'y que el cliente haya confirmado el resumen en voz alta.',
    parameters: z.object({
      ...fechaHora,
      nombre: z.string().min(2).describe('Nombre de la persona que reserva'),
      telefono: z.string().min(7).describe('Teléfono de contacto, solo dígitos y prefijo'),
      notas: z.string().describe('Peticiones especiales, alergias u ocasión. Cadena vacía si no hay.'),
    }),
    execute: async ({ fecha, hora, personas, nombre, telefono, notas }) => {
      const motivo = await comprobarDisponibilidad(fecha, hora, personas);
      if (motivo) return { reservada: false, motivo };

      const reservas = await leerReservas();
      const codigo = `MG-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      reservas.push({ codigo, nombre, telefono, fecha, hora, personas, notas, creada: new Date().toISOString() });
      await writeFile(ARCHIVO_RESERVAS, JSON.stringify(reservas, null, 2));
      return { reservada: true, codigo };
    },
  }),

  cancelar_reserva: llm.tool({
    description: 'Cancela una reserva existente con su código y el teléfono con el que se hizo.',
    parameters: z.object({
      codigo: z.string().describe('Código de la reserva, por ejemplo MG-AB12'),
      telefono: z.string().describe('Teléfono con el que se hizo la reserva'),
    }),
    execute: async ({ codigo, telefono }) => {
      const soloDigitos = (t: string) => t.replace(/\D/g, '');
      const reservas = await leerReservas();
      const indice = reservas.findIndex(
        (r) => r.codigo.toUpperCase() === codigo.toUpperCase().replace(/\s/g, '') &&
          soloDigitos(r.telefono).endsWith(soloDigitos(telefono).slice(-7)),
      );
      if (indice === -1) return { cancelada: false, motivo: 'No hay ninguna reserva con ese código y teléfono.' };
      const [cancelada] = reservas.splice(indice, 1);
      await writeFile(ARCHIVO_RESERVAS, JSON.stringify(reservas, null, 2));
      return { cancelada: true, fecha: cancelada.fecha, hora: cancelada.hora };
    },
  }),
};

function instrucciones() {
  const ahora = ahoraEnColombia();
  const r = RESTAURANTE;
  return `
# Rol y objetivo
Eres Valentina, la asistente de reservas por voz del restaurante ${r.nombre}, un mirador con restaurante en Zapatoca, Santander.
Tu objetivo es tomar, confirmar y cancelar reservas de mesa de forma rápida y amable.
Hoy es ${DIAS[diaDeLaSemana(ahora.fecha)]} ${ahora.fecha} y son las ${ahora.hora} en Colombia. Usa esto para entender "hoy", "mañana" o "el sábado".

# Datos del restaurante
- Dirección: ${r.direccion}.
- Horario: de ${r.apertura} a ${r.cierre}, todos los días excepto los ${DIAS[r.diaCerrado]}, que está cerrado.
- Se reserva entre las ${r.apertura} y las ${r.ultimaReserva}.
- Lo más destacado es la vista panorámica, desde donde se ven los pueblos cercanos.
- No tienes la carta, los precios ni el teléfono del restaurante. Si te preguntan, dilo con naturalidad y no inventes nada.

# Personalidad y tono
- Cálida, cercana y eficiente, con el trato amable de Santander. Trata al cliente de "usted".
- Suena natural y tranquila, nunca robótica. Varía tus frases.

# Idioma
- Habla en español de Colombia. Si el cliente habla otro idioma, responde en ese idioma.

# Razonamiento
- Antes de responder, piensa qué dato te falta para completar la reserva. Pide solo ese dato.
- Guarda tu razonamiento para ti y di solo la respuesta.

# Canales de mensaje
- Todo lo que dices se convierte en voz y aparece como transcripción en la pantalla.
- Nunca uses markdown, listas, emojis ni símbolos. Di las horas como se hablan, por ejemplo "a la una de la tarde".

# Preámbulos
- Antes de usar una herramienta, di una frase muy corta como "Déjeme revisar" o "Un momento, se la confirmo".

# Verbosidad
- Respuestas de una o dos frases. Una pregunta a la vez.

# Herramientas
- Proceso de reserva, en este orden:
  1. Pregunta la fecha, la hora y el número de personas.
  2. Usa verificar_disponibilidad. Si no hay cupo, explica el motivo y ofrece una alternativa cercana.
  3. Pide el nombre y un teléfono de contacto, y pregunta si hay alguna petición especial, alergia u ocasión.
  4. Resume en voz alta fecha, hora, personas, nombre y teléfono, y pide confirmación.
  5. Solo cuando el cliente confirme, usa crear_reserva y dile el código de reserva letra por letra.
- Para cancelar, pide el código y el teléfono y usa cancelar_reserva.
- Nunca digas que una reserva está hecha si crear_reserva no devolvió reservada: true.
- No puedes enviar mensajes, correos ni WhatsApp. No lo prometas.

# Audio poco claro
- Si no entiendes bien, no adivines. Pide con amabilidad que lo repita: "Disculpe, no le escuché bien, ¿me lo repite?"

# Captura de datos
- Repite el teléfono dígito a dígito para confirmarlo, agrupado de tres en tres.
- Si un nombre es poco común, pide que lo deletree.
- Convierte fechas relativas a fechas concretas y confírmalas: "¿El sábado veintinueve de noviembre, correcto?"

# Conversaciones largas
- Si el cliente cambia un dato, vuelve a verificar la disponibilidad antes de reservar.
- Al final, despídete con la fecha y hora de la reserva y una frase amable.

# Escalamiento
- Para grupos grandes, eventos privados, quejas o cualquier cosa que no puedas resolver,
  di que esa solicitud debe gestionarla directamente el personal del restaurante.
- Si el cliente insiste en hablar con una persona, díselo con amabilidad y no inventes un número de contacto.
`;
}

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();

    const session = new AgentSession({
      // A speech-to-speech model from LiveKit Inference. It needs no extra API key.
      // Other models: https://docs.livekit.io/agents/models/
      llm: new inference.RealtimeModel({ model: 'openai/gpt-realtime-2.1', voice: 'marin' }),
    });

    await session.start({
      room: ctx.room,
      // Removes background voices and noise, so nearby talk does not reach the model as a user turn.
      inputOptions: { noiseCancellation: BackgroundVoiceCancellation() },
      agent: new Agent({
        instructions: instrucciones(),
        tools: herramientas,
      }),
    });

    session.generateReply({
      instructions:
        'Saluda según la hora del día, preséntate como Valentina de Mirador Guane ' +
        'y pregunta en qué le puedes ayudar con su reserva.',
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'german-ai-teacher-agent', // Must match AGENT_NAME in src/app/token+api.ts.
    port: 8082, // The default port, 8081, belongs to Metro.
  }),
);
