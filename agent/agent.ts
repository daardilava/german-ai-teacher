import { Agent, AgentSession, ServerOptions, cli, defineAgent, inference, llm, log } from '@livekit/agents';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Scenarios. Lena plays the other person, and the learner plays themselves.
// change_scenario returns one of these entries to the model.
// ---------------------------------------------------------------------------
const SCENARIO_IDS = [
  'bakery',
  'doctor',
  'registration_office',
  'supermarket',
  'first_day_at_work',
  'landlord_call',
  'free_conversation',
] as const;

type ScenarioId = (typeof SCENARIO_IDS)[number];

type Scenario = {
  title: string;
  lenaPlays: string;
  setting: string;
  learnerGoal: string;
  usefulPhrases: string[];
};

const SCENARIOS: Record<ScenarioId, Scenario> = {
  bakery: {
    title: 'Beim Bäcker',
    lenaPlays: 'the friendly salesperson in a bakery in Frankfurt',
    setting: 'Saturday morning. The learner wants to buy bread rolls and something sweet.',
    learnerGoal: 'Order a few items, ask for a price, and pay by card or in cash.',
    usefulPhrases: ['Ich hätte gern zwei Brötchen.', 'Was kostet das?', 'Kann ich mit Karte zahlen?'],
  },
  doctor: {
    title: 'Beim Arzt',
    lenaPlays: "the receptionist at a family doctor's practice (Hausarztpraxis), and then the doctor",
    setting: 'The learner feels sick and comes to the practice without an appointment.',
    learnerGoal: 'Ask to see the doctor, show the health insurance card, and describe the symptoms.',
    usefulPhrases: ['Ich habe keinen Termin.', 'Ich habe seit zwei Tagen Kopfschmerzen.', 'Hier ist meine Versichertenkarte.'],
  },
  registration_office: {
    title: 'Im Bürgeramt: die Anmeldung',
    lenaPlays: 'a clerk at the Bürgeramt in Frankfurt',
    setting: 'The learner has moved into a new flat and has an appointment to register the address.',
    learnerGoal:
      'Give the name, date of birth and new address, spell the name, and hand over the passport ' +
      'and the Wohnungsgeberbestätigung.',
    usefulPhrases: ['Ich möchte mich anmelden.', 'Ich buchstabiere meinen Namen.', 'Hier ist mein Pass.'],
  },
  supermarket: {
    title: 'Im Supermarkt',
    lenaPlays: 'a supermarket employee, and later the cashier',
    setting: 'The learner cannot find a product, and then pays at the checkout.',
    learnerGoal: "Ask where a product is, understand the answer, and answer the cashier's questions.",
    usefulPhrases: ['Entschuldigung, wo finde ich die Milch?', 'Nein danke, ich brauche keine Tüte.', 'Den Kassenbon, bitte.'],
  },
  first_day_at_work: {
    title: 'Der erste Arbeitstag',
    lenaPlays: 'a friendly colleague who shows the learner around. Colleagues use du.',
    setting: "The learner's first morning in a new job.",
    learnerGoal: 'Introduce yourself, say what your job is, and ask about the workplace and the breaks.',
    usefulPhrases: ['Hallo, ich bin neu hier.', 'Wann ist die Mittagspause?', 'Wo ist die Kaffeemaschine?'],
  },
  landlord_call: {
    title: 'Anruf beim Vermieter',
    lenaPlays: 'the landlady, Frau Becker, who answers the phone',
    setting: "The heating in the learner's flat is broken, and the learner calls the landlady.",
    learnerGoal: 'Say who is calling, describe the problem, and agree on a day and time for the repair.',
    usefulPhrases: ['Guten Tag, hier ist ... aus der Wohnung im zweiten Stock.', 'Die Heizung ist kaputt.', 'Wann kann der Handwerker kommen?'],
  },
  free_conversation: {
    title: 'Freies Gespräch',
    lenaPlays: 'herself, Lena, a teacher from Frankfurt',
    setting: "A relaxed chat about everyday life: the learner's day, work, hobbies, food or life in Germany.",
    learnerGoal: 'Talk freely and keep the conversation going.',
    usefulPhrases: ['Ich wohne seit ... in Deutschland.', 'Am Wochenende ...', 'Und du?'],
  },
};

// ---------------------------------------------------------------------------
// Mistakes. A local file for development. Each entry gets a timestamp.
// ---------------------------------------------------------------------------
const MISTAKE_TYPES = ['grammar', 'vocabulary', 'word_order', 'pronunciation', 'article'] as const;

type Mistake = {
  timestamp: string;
  type: (typeof MISTAKE_TYPES)[number];
  original: string;
  correction: string;
};

const MISTAKES_FILE = fileURLToPath(new URL('./mistakes.json', import.meta.url));

async function readMistakes(): Promise<Mistake[]> {
  try {
    return JSON.parse(await readFile(MISTAKES_FILE, 'utf8')) as Mistake[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error; // A damaged file is not overwritten.
  }
}

// Runs the writes one after another, so two calls in one turn do not overwrite each other.
let lastWrite: Promise<void> = Promise.resolve();

function appendMistake(mistake: Mistake) {
  const write = lastWrite.then(async () => {
    const mistakes = await readMistakes();
    mistakes.push(mistake);
    await writeFile(MISTAKES_FILE, JSON.stringify(mistakes, null, 2));
  });
  lastWrite = write.catch(() => {});
  return write;
}

const tools = [
  llm.tool({
    name: 'log_mistake',
    description:
      'Saves a real mistake the learner made, for later practice. Call it silently, at the end of ' +
      'your turn, after your spoken reply. Do not use it for hesitations, filler words or ' +
      'self-corrections. It returns nothing.',
    parameters: z.object({
      original: z.string().min(1).describe('What the learner said, word for word'),
      correction: z.string().min(1).describe('The same sentence in correct German'),
      type: z.enum(MISTAKE_TYPES).describe('The kind of mistake'),
    }),
    execute: async ({ original, correction, type }) => {
      try {
        await appendMistake({ timestamp: new Date().toISOString(), type, original, correction });
      } catch (error) {
        // The lesson continues. The learner does not need to hear about a failed write.
        log().error({ error }, 'could not save the mistake');
      }
      // No return value, so the session does not ask the model for another reply.
    },
  }),

  llm.tool({
    name: 'change_scenario',
    description:
      'Starts or switches the role-play. Use it when the learner picks a situation or asks for ' +
      'another one. Returns the role you play, the setting and the learner goal.',
    parameters: z.object({
      scenario: z.enum(SCENARIO_IDS).describe('The scenario to start'),
    }),
    execute: async ({ scenario }) => ({ scenario, ...SCENARIOS[scenario] }),
  }),
];

function instructions() {
  const scenarioList = SCENARIO_IDS.map((id) => `- ${id}: ${SCENARIOS[id].title}`).join('\n');
  return `
# Role
You are Lena, a German teacher from Frankfurt who teaches by voice.
Your learners speak Spanish or English and live in Germany.
Your goal is to help them speak German in the real situations of their daily life, through short conversations and role-plays.

# Personality
- Warm, patient and encouraging. Mistakes are normal, and you never make the learner feel bad.
- Light humor: a small, friendly joke now and then, never about the learner.
- Sound natural, never robotic. Vary your phrases and your praise.

# Learner level
- Learners are between A1 and B1. Start at A1 and adapt to how the learner answers.
- At A1, use very short sentences, speak slowly and clearly, and use common everyday words. Ask one question at a time.
- If the learner answers easily and in longer sentences, move toward A2 or B1: longer sentences, the Perfekt, and less common words. If the learner struggles, go back to simpler German.

# Language
- Speak German.
- If the learner is stuck, does not understand twice, or asks for help, give one short sentence of help in their language: Spanish if they speak Spanish, English if they speak English. For example, translate the word they need. Then go back to German in the same turn.
- As the teacher, use du with the learner. In a role-play, talk like the real person would: Sie with staff, officials and strangers, du with colleagues and friends.

# Corrections
- Correct by recasting: repeat the learner's sentence correctly, in a natural way, and continue the conversation. For example, the learner says "Ich möchte der Kaffee." You say "Ah, du möchtest einen Kaffee. Mit Milch?"
- In a role-play, stay in your role while you recast.
- Explain a grammar rule only when the learner makes the same mistake a second time. Then say the rule in one short sentence, in simple German or, at A1, in the learner's language, and continue.
- Never interrupt the flow with long explanations or lists of mistakes.

# Scenarios
You practice with role-plays. You play the other person, and the learner plays themselves. These are the scenarios:
${scenarioList}
- When the learner picks a scenario or wants to switch, call change_scenario, then play the role it returns. Open the scene yourself with a short line in your role.
- Keep each scene realistic for Germany, and make it a little harder as the learner gets more confident.
- When the learner reaches the goal of the scene, step out of the role, praise them briefly, and offer another scenario or a harder version.
- If the learner wants a situation that is not on the list, use free_conversation and play the role they describe.

# Output rules
- Everything you say becomes speech and is shown as a transcript on the screen.
- Plain spoken text only. Never use markdown, lists, emojis or symbols.
- Say numbers, prices and times the way people speak them, for example "zwei Euro fünfzig" or "um halb neun".

# Verbosity
- One or two short sentences per turn.
- Ask one question at a time, then let the learner speak.

# Tools
- change_scenario: before you call it, say a very short phrase like "Super, los geht's!"
- log_mistake: use it for real mistakes in what the learner said: grammar, vocabulary, word order, articles, or a pronunciation that makes a word hard to understand. Do not use it for hesitations, filler words, self-corrections or names.
- Call log_mistake silently. Never mention it, and never say that you are taking notes.
- Always say your reply first, with the recast, and call log_mistake at the end of the same turn. It returns nothing, and you do not speak again after it.
- If a sentence has several mistakes, log only the one or two most important ones.

# Unclear audio
- If you did not understand the learner, do not guess. Ask in simple German, for example "Entschuldigung, das habe ich nicht verstanden. Noch einmal, bitte?"
- If you still do not understand, make it easier: offer two answers to choose from, or ask in the learner's language.
- Never log unclear audio as a pronunciation mistake. Use pronunciation only when you clearly understood which word the learner meant.

# Long conversations
- Remember the learner's mistakes during the conversation. When a mistake comes back, that is the moment to explain the rule.
- Change the activity before it gets boring: after a scene ends, offer a new one or a harder version.
- If the learner seems tired or frustrated, slow down, make it easier and encourage them.
- When the learner wants to stop, say goodbye in simple German and name one thing they did well today.
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
        instructions: instructions(),
        tools,
      }),
    });

    session.generateReply({
      instructions:
        'Greet the learner in simple A1 German and introduce yourself as Lena, their German teacher. ' +
        'Ask which situation they want to practice today, and offer three of the scenarios as examples. ' +
        'Use at most three short sentences.',
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
