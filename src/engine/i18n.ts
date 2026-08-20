/**
 * i18n — language detection + enforcement for the 5 supported languages:
 * English (en), Nigerian Pidgin (pcm), Yoruba (yo), Igbo (ig), Hausa (ha).
 *
 * We detect the user's language with a lightweight keyword/diacritic scorer
 * (no network, no model) and then INSTRUCT the LLM, in the system prompt, to
 * reply in that same language. This gives reliable multilingual behavior even
 * on the offline mock and cheap models, and improves accuracy on real ones.
 */
import type { LanguageCode } from "../types.js";
import { LANGUAGE_NAMES } from "../types.js";

// Strong signal words per language. Kept short but high-precision.
const MARKERS: Record<Exclude<LanguageCode, "en">, string[]> = {
  pcm: [
    "abeg", "wetin", "dey", "wahala", "oga", "na so", "no be", "sabi",
    "make i", "how far", "biko abeg", "una", "comot", "waka", "chop", "gist",
  ],
  yo: [
    "bawo", "se daadaa", "jowo", "e se", "mo fe", "kilode", "omo", "oga mi",
    "pele", "báwo", "ṣé", "jọ̀wọ́", "ẹ", "mí", "ọ", "kí", "ni", "báwo ni",
  ],
  ig: [
    "kedu", "biko", "daalu", "nnoo", "ọ", "achọrọ", "gịnị", "nwanne",
    "kedụ", "ị", "ụ", "ọdị", "ndewo", "maka", "ego", "ọ dị mma",
  ],
  ha: [
    "sannu", "yaya", "nawa", "ina", "kana", "don allah", "madalla", "barka",
    "yaushe", "menene", "ya kake", "lafiya", "na gode", "kana lafiya", "ranka",
  ],
};

// Diacritic ranges that hint Yoruba/Igbo (dotted/underdotted vowels, tone marks).
const YO_IG_DIACRITICS = /[ẹọṣńǹáàéèíìóòúụ̀]/i;

export function detectLanguage(text: string): LanguageCode {
  const t = text.toLowerCase();
  const scores: Record<LanguageCode, number> = { en: 0.5, pcm: 0, yo: 0, ig: 0, ha: 0 };

  (Object.keys(MARKERS) as Exclude<LanguageCode, "en">[]).forEach((lang) => {
    for (const word of MARKERS[lang]) {
      // word-boundary-ish match; many markers are multi-word
      if (t.includes(word)) scores[lang] += 2;
    }
  });

  if (YO_IG_DIACRITICS.test(text)) {
    scores.yo += 1;
    scores.ig += 1;
  }

  // Pick the highest; ties fall back to English (safe default).
  let best: LanguageCode = "en";
  let bestScore = scores.en;
  (Object.keys(scores) as LanguageCode[]).forEach((lang) => {
    if (scores[lang] > bestScore) {
      best = lang;
      bestScore = scores[lang];
    }
  });
  return best;
}

/** The instruction appended to the system prompt to enforce the language. */
export function languageDirective(lang: LanguageCode): string {
  const name = LANGUAGE_NAMES[lang];
  if (lang === "en") {
    return "Reply in clear, standard English.";
  }
  return `The user is writing in ${name}. You MUST reply fluently and naturally in ${name}, matching their dialect and tone. Do not switch to English unless the user does.`;
}

/** Localized "let me get a human" escalation line shown to the user. */
export function escalationMessage(lang: LanguageCode, agentName: string): string {
  const messages: Record<LanguageCode, string> = {
    en: `I want to give you accurate information rather than guess, so I'd like to connect you with a specialist from our team. Could you share your name and email so they can follow up with the exact answer?`,
    pcm: `I no wan guess and tell you wrong thing, so make I link you with person for our team wey sabi am well. Abeg fit drop your name and email make dem reach you with the correct answer?`,
    yo: `Mo fẹ́ fún ọ ní ìdáhùn tí ó tọ́, dípò kí n máa fojú díwọ̀n. Jọ̀wọ́ ẹ jẹ́ kí n so ọ́ pọ̀ mọ́ ọ̀gá wa. Ṣé o lè fún mi ní orúkọ àti ímeèlì rẹ kí wọ́n lè kàn sí ọ?`,
    ig: `Achọrọ m ịnye gị azịza ziri ezi karịa ịtụ anya. Biko ka m jikọọ gị na onye ọkachamara anyị. Ị nwere ike inye m aha na email gị ka ha kpọtụrụ gị?`,
    ha: `Ina son ba ka amsa daidai maimakon in yi kintata, don haka bari in haɗa ka da kwararre daga tawagarmu. Za ka iya ba ni sunanka da imel domin su tuntube ka?`,
  };
  return messages[lang];
}
