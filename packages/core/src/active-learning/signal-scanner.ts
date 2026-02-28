/**
 * Signal Scanner — pure function, ~1ms, no dependencies.
 * Classifies user messages as high or low signal for memory extraction.
 * Bilingual: German + English patterns.
 */

export interface SignalResult {
  level: 'high' | 'low';
  matchedPatterns: string[];
}

// Low-signal filters: questions, greetings, commands → reject immediately
const LOW_SIGNAL_PATTERNS: RegExp[] = [
  // Questions (starting with question words)
  /^(what|where|when|who|why|how|which|can you|could you|do you|is there|are there|was |wer |wo |wann |warum |wie |welch|kannst du|könntest du|gibt es)/i,
  // Greetings
  /^(hi|hey|hello|hallo|guten (morgen|tag|abend)|moin|servus|grüß|na\b|yo\b|sup\b|good (morning|evening|night))\b/i,
  // Commands / requests (imperative)
  /^(tell me|show me|find|search|help|explain|describe|translate|summarize|zeig|such|hilf|erklär|beschreib|übersetze|fass zusammen)/i,
  // Short acknowledgements
  /^(ok|okay|yes|no|ja|nein|danke|thanks|thank you|sure|alright|klar|gut|cool|nice|great|perfect|genau|stimmt|richtig)\b/i,
];

// High-signal patterns: facts, preferences, corrections, relationships
interface PatternGroup {
  name: string;
  patterns: RegExp[];
}

const HIGH_SIGNAL_GROUPS: PatternGroup[] = [
  {
    name: 'fact:name',
    patterns: [
      /\b(my name is|i'm called|i am called|ich heiße|ich bin der|ich bin die|mein name ist)\b/i,
    ],
  },
  {
    name: 'fact:location',
    patterns: [
      /\b(i live in|i'm from|i am from|ich wohne|ich lebe in|ich komme aus|ich bin aus)\b/i,
    ],
  },
  {
    name: 'fact:work',
    patterns: [
      /\b(i work at|i work as|i work for|ich arbeite|mein job|mein beruf|ich bin .{0,20}(entwickler|ingenieur|lehrer|arzt|designer))\b/i,
    ],
  },
  {
    name: 'fact:birthday',
    patterns: [
      /\b(my birthday|i was born|ich bin geboren|mein geburtstag|ich habe am .{1,15} geburtstag)\b/i,
    ],
  },
  {
    name: 'fact:age',
    patterns: [
      /\b(i'm \d+ years|i am \d+ years|ich bin \d+ (jahre|jahr))\b/i,
    ],
  },
  {
    name: 'preference:like',
    patterns: [
      /\b(i love|i really like|i enjoy|ich liebe|ich mag|mir gefällt|mir gefallen)\b/i,
    ],
  },
  {
    name: 'preference:dislike',
    patterns: [
      /\b(i hate|i dislike|i can't stand|ich hasse|ich mag .{0,5} nicht|ich kann .{0,10} nicht leiden)\b/i,
    ],
  },
  {
    name: 'preference:prefer',
    patterns: [
      /\b(i prefer|i'd rather|ich bevorzuge|ich nehme lieber|mir ist .{0,10} lieber)\b/i,
    ],
  },
  {
    name: 'preference:favorite',
    patterns: [
      /\b(my fav|my favorite|my favourite|mein lieblings|meine lieblings|am liebsten)\b/i,
    ],
  },
  {
    name: 'correction',
    patterns: [
      /\b(actually|actually,? (i|my|it)|eigentlich|das stimmt nicht|nein,? ich|that's not right|that's wrong|nicht ganz)\b/i,
    ],
  },
  {
    name: 'relationship:family',
    patterns: [
      /\b(my wife|my husband|my partner|meine frau|mein mann|mein partner|meine partnerin|my daughter|my son|mein sohn|meine tochter|my kids|meine kinder|my mother|my father|meine mutter|mein vater)\b/i,
    ],
  },
  {
    name: 'relationship:professional',
    patterns: [
      /\b(my boss|my manager|my colleague|mein chef|mein vorgesetzter|mein kollege|meine kollegin)\b/i,
    ],
  },
  {
    name: 'relationship:social',
    patterns: [
      /\b(my friend|my best friend|mein freund|meine freundin|mein bester freund)\b/i,
    ],
  },
  {
    name: 'fact:language',
    patterns: [
      /\b(i speak|ich spreche|my native|meine muttersprache)\b/i,
    ],
  },
  {
    name: 'fact:education',
    patterns: [
      /\b(i studied|i went to|ich habe .{0,10} studiert|ich war auf der|mein studium)\b/i,
    ],
  },
  {
    name: 'fact:hobby',
    patterns: [
      /\b(my hobby|i play .{0,10}(guitar|piano|football|tennis|chess)|mein hobby|ich spiele|in my free time|in meiner freizeit)\b/i,
    ],
  },
  {
    name: 'decision',
    patterns: [
      /\b(i've decided|i decided|i will always|ich habe (mich )?entschieden|ich werde immer)\b/i,
    ],
  },
  {
    name: 'commitment',
    patterns: [
      /\b(i always|i never|ich mache immer|ich mache nie|i'm trying to|ich versuche)\b/i,
    ],
  },
];

/**
 * Scan a user message for memory-relevant signals.
 * Pure function, no side effects, ~1ms execution.
 */
export function scanSignal(message: string): SignalResult {
  const trimmed = message.trim();

  // Too short — not worth analyzing
  if (trimmed.length < 10) {
    return { level: 'low', matchedPatterns: [] };
  }

  // Check low-signal patterns first (fast reject)
  for (const pattern of LOW_SIGNAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { level: 'low', matchedPatterns: [] };
    }
  }

  // Check high-signal patterns
  const matchedPatterns: string[] = [];
  for (const group of HIGH_SIGNAL_GROUPS) {
    for (const pattern of group.patterns) {
      if (pattern.test(trimmed)) {
        matchedPatterns.push(group.name);
        break; // One match per group is enough
      }
    }
  }

  if (matchedPatterns.length > 0) {
    return { level: 'high', matchedPatterns };
  }

  return { level: 'low', matchedPatterns: [] };
}
