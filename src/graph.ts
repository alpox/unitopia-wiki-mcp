import { ChatOllama } from "@langchain/ollama";
import { Document } from "@langchain/core/documents";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  trimMessages,
} from "@langchain/core/messages";
import {
  Annotation,
  END,
  START,
  StateGraph,
  MessagesAnnotation,
} from "@langchain/langgraph";
import type { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { type HybridSearch } from "./hybrid.js";
import { config } from "./config.js";
import { type CatalogIndex, type CatalogEntry, readPageBody } from "./catalog.js";
import { type NavIndex, type RouteCandidates } from "./nav/navIndex.js";
import { formatRoute, type RouteResult } from "./nav/mapGraph.js";

/**
 * Graph state: the standard message channel plus RAG-specific fields.
 * MessagesAnnotation gives us an append/merge reducer for `messages`.
 */
const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  question: Annotation<string>(),
  documents: Annotation<Document[]>(),
  context: Annotation<string>(),
  route: Annotation<string>(),
  mapView: Annotation<string>(),
});

type State = typeof GraphState.State;

const SYSTEM_PROMPT = `Du bist ein kundiger Kenner der Spielwelt des deutschsprachigen Text-MUDs **Unitopia**. Der bereitgestellte CONTEXT enthält gesichertes Spielwissen über Unitopia: Gegenstände, NPCs, Räume, Gegenden, Gilden, Rassen, Rätsel und Quests.

Antworte immer auf **Deutsch**.

Grundhaltung – du redest über die SPIELWELT, nicht über ein Wiki:
- Der CONTEXT IST dein Spielwissen. Behandle alle Angaben als Fakten der Spielwelt von Unitopia.
- Schreibe **niemals** „laut Wiki", „im Wiki steht", „Wiki-Seite", „laut der Seite" o. Ä. und hänge **keine** Quellen-, Link- oder „Wiki-Quellen"-Liste an. Gib keine URLs aus.

Wahrheitstreue:
- Stütze dich **ausschließlich auf den CONTEXT**. Erfinde nichts – keine Orte, NPCs, Gegenstände, Gegenden, Mechaniken oder Werte.
- Fehlt die Antwort im CONTEXT, sage das knapp (z. B. „Dazu habe ich keine Informationen.") und rate nicht.
- **Zahlenwerte** (z. B. Werte, Schaden, Gewicht) nennst du nur, wenn sie **wörtlich** im CONTEXT stehen (z. B. im Abschnitt „Kenndaten"). Schätze, runde oder erfinde keine Zahlen; liegt der Wert nicht vor, sage das.
- **Erfahrung:** Der Wert „Erfahrung" in den Kenndaten ist ein Rohwert. Die im Spiel angezeigten Prozente ergeben sich, indem du ihn **durch 1000 teilst** (z. B. Erfahrung 3000 → **3,00 %**; 500 → 0,50 %). Gib bei Erfahrungsfragen diese Prozentangabe an (Format „3,00 %"). Nimm keine andere Umrechnung vor.

Befehle (sehr wichtig):
- **Erfinde niemals Spielbefehle.** Gib nur Befehle an, die **wörtlich** im CONTEXT vorkommen, in \`Code\`-Formatierung.
- Es gibt **keinen** Befehl wie \`go <Name>\` o. Ä. Erfinde keine Wege-, Reise- oder Teleportbefehle. Erwähnst du Bewegung, dann nur, was der CONTEXT belegt.

Fundorte:
- Bei „Wo finde ich X?" nenne den konkreten **Fundort / die Heimat / die Gegend** aus dem CONTEXT (Gegend, Stadt, Lage des Gebäudes) und **beschreibe die Lage in Worten** – statt einen Befehl dorthin zu erfinden. Nutze auch verknüpfte Orts-/Gegend-Einträge im CONTEXT, um die Lage genauer einzuordnen.

Mehrdeutigkeit:
- Steht ein Name für mehrere Dinge (z. B. einen NPC und mehrere Gegenstände), unterscheide sie klar und beantworte jedes anhand des CONTEXT.

Wege, Bewegung & Karten:
- Bewegung erfolgt ausschließlich über Richtungsbefehle: \`westen\`, \`osten\`, \`norden\`, \`süden\`/\`sueden\`, \`nordosten\`, \`nordwesten\`, \`südosten\`/\`suedosten\`, \`südwesten\`/\`suedwesten\`, \`hoch\`, \`runter\`, \`rein\`, \`raus\`. Erfinde keine anderen Befehle (kein \`go\`, kein \`gehe <Ort>\`).
- **Erfinde NIEMALS Richtungen oder Wege – auch keine einzelne Richtung wie „nach Norden".** Eine Wegbeschreibung gibst du nur, wenn sie als **ausdrücklicher Wegtext** (eine konkrete Folge von Richtungsbefehlen) wörtlich im CONTEXT steht.
- **Lies/rate Wege NICHT aus einer ASCII-Karte ab.** Wird nach einem Weg gefragt und es gibt keinen wörtlichen Wegtext: sage klar „Einen genauen Weg kann ich dir dazu nicht zuverlässig angeben." Du darfst dann den relevanten **Karten-Block unverändert in einem Codeblock** zeigen, die **Legende** erklären (\`|\`=Nord/Süd, \`-\`=West/Ost, \`/\`=NO/SW, \`\\\\\`=NW/SO, \`˄\`=hoch, \`˅\`=runter) und die **Nummern den Räumen** zuordnen – aber leite daraus keine Schrittfolge ab.
- **Erfinde niemals eine Karte.** Gib eine ASCII-Karte nur wieder, wenn sie **tatsächlich im CONTEXT** steht. Liegt keine Karte vor, sage das – baue keine eigene (z. B. leere \`| | |\`-Raster).
- Steht im CONTEXT ein Block **„BERECHNETER WEG"**, dann ist dieser Weg verbindlich und exakt aus der Karte berechnet: gib die Richtungsfolge **unverändert** wieder, ebenso den \`tue\`-Befehl. Enthält der Block einen **„Kartenausschnitt des Weges:"** mit einem \`\`\`-Codeblock, gib diesen Codeblock **immer vollständig und unverändert** (samt \`\`\`-Zeilen) mit aus – niemals weglassen. Ändere keine Richtung und ergänze keine eigenen Schritte. Gibt es keinen solchen Block, erfinde keinen Weg.
- **Richtungswörter wörtlich übernehmen:** Gib die Richtungen exakt als **kommagetrennte Liste** der Original-Tokens aus (genau \`norden, sueden, osten, westen, nordosten, nordwesten, suedosten, suedwesten, hoch, runter\`). **Übersetze oder ersetze sie NICHT** – also kein „ostwärts", „westwärts", „südlich", „nach Norden", kein vorangestelltes „Geh" und keine nummerierte Umschreibung. Beispiel-Ausgabe: \`osten, sueden, sueden, suedwesten\`.

Listen & Übersichten:
- Fragt der Nutzer nach einer Liste/Übersicht (z. B. „alle Rätsel", „welche Gilden gibt es"), nutze die im CONTEXT bereitgestellte **Kategorie-Liste** („Kategorie ‚…' — N Einträge") und zähle die Einträge auf. Nenne die Gesamtzahl. Behaupte nicht, du wüsstest es nicht, wenn eine solche Liste vorhanden ist.

Stil:
- Präzise, knapp, gut strukturiert. Bewahre Eigennamen und Schreibweisen exakt so wie im CONTEXT.`;

function formatContext(docs: Document[]): string {
  if (docs.length === 0) return "(kein relevanter Kontext gefunden)";
  return docs
    .map((d, i) => {
      const title = d.metadata?.title ?? "Eintrag";
      return `[${i + 1}] ${title}\n${d.pageContent}`;
    })
    .join("\n\n");
}

/** Parse a "Weg von X nach Y" question into the two room endpoints. */
/** Cheap gate: does this text look like it's asking for a route at all? */
function routeIntentCue(q: string): boolean {
  return /\b(weg|route|wegbeschreibung|wie\s+(komme|gelange|laufe)|how\s+(do|can|to)|get\s+(to|from)|way\s+(to|from)|directions?|von\b.*\b(nach|zu|zum|zur)|from\b.*\bto\b)\b/i.test(q);
}

/** Cheap gate for map-display intent (incl. accepting an offered map a turn
 *  later: the offer text itself carries "Karte"). Only gates whether to consult
 *  the LLM — the LLM does the actual intent + area extraction. */
function mapIntentCue(convo: string): boolean {
  return /\b(karte|stadtplan|lageplan|landkarte|\bplan\b|\bmap\b)\b/i.test(convo);
}

/** LLM map-intent extraction (gated by `mapIntentCue`): does the user want a
 *  MAP/Stadtplan of some area shown? Language- and phrasing-agnostic, and
 *  conversation-aware (e.g. "ja, zeig sie mir" after a map was offered). */
async function extractMapIntentLLM(llm: ChatOllama, convo: string): Promise<{ area: string } | null> {
  const sys = new SystemMessage(
    `Erkenne, ob der Nutzer darum bittet, eine KARTE / einen (Stadt-)Plan eines Ortes oder Gebietes ANGEZEIGT zu bekommen — auch über mehrere Nachrichten verteilt (z. B. „ja, zeig sie mir", nachdem eine Karte angeboten wurde) und unabhängig von der Sprache. NICHT gemeint sind Fragen nach Kauf/Fundort/Preis des Gegenstands „Karte". Wenn ja, gib das GENAU gemeinte Gebiet zurück — so spezifisch wie genannt, inkl. Teilgebiet UND Stadt (z. B. „Hafengebiet von Tadmor", NICHT nur „Tadmor"): {"area":"…"}. Sonst: {"none":true}. Antworte ausschließlich mit JSON.`,
  );
  const usr = new HumanMessage(`Gesprächsverlauf (neueste Nachricht zuletzt):\n${convo}`);
  try {
    const obj = extractJsonObject(contentToTextLocal(await llm.invoke([sys, usr])));
    if (!obj || obj.none || !obj.area) return null;
    return { area: String(obj.area) };
  } catch (err) {
    console.error("[map] LLM intent extraction failed:", err);
    return null;
  }
}

/** LLM picks the ONE sub-map the user means from gathered candidates (the
 *  entity-resolution half — a sub-map may be named differently than the request,
 *  e.g. area "Hafengebiet" → sub-map "Hafen"). Code then renders it. */
async function resolveMapView(
  llm: ChatOllama,
  query: string,
  area: string,
  cands: { page: string; maps: { anchor: string; rooms: string[] }[] }[],
): Promise<{ page: string; anchor: string } | null> {
  const lists = cands
    .map((c) => `[Seite: ${c.page}]\n${c.maps.map((m) => `- Teilkarte „${m.anchor}": ${m.rooms.join(", ")}`).join("\n")}`)
    .join("\n\n");
  const sys = new SystemMessage(
    `Du wählst aus den unten gelisteten Teilkarten GENAU EINE aus, die der Nutzer angezeigt haben möchte. Wähle Seite (page) und Teilkarte (anchor) NUR aus der Liste (exakt). Eine Teilkarte kann anders heißen als die Anfrage — achte auf das gemeinte Gebiet (z. B. „Hafengebiet" → Teilkarte „Hafen", „die Stadt" → „Stadtplan"). Kannst du es nicht sicher zuordnen, gib einen Fehler zurück. Antworte ausschließlich mit JSON: {"page":"<conceptId>","anchor":"<Teilkartenname>"} oder {"error":"…"}.`,
  );
  const usr = new HumanMessage(`Frage: "${query}"\nGemeintes Gebiet: "${area}"\n\nVerfügbare Teilkarten:\n${lists}`);
  try {
    const obj = extractJsonObject(contentToTextLocal(await llm.invoke([sys, usr])));
    if (!obj || obj.error || !obj.page || !obj.anchor) return null;
    return { page: String(obj.page), anchor: String(obj.anchor) };
  } catch (err) {
    console.error("[map] LLM sub-map resolution failed:", err);
    return null;
  }
}

/** Build the authoritative map-display block injected for `generate`. */
function formatMapView(mv: { area: string; block: string }): string {
  return (
    `KARTENANZEIGE „${mv.area}": Der Nutzer möchte diese Karte sehen. Gib den folgenden Kartenblock wieder — den ` +
    "```-Codeblock Zeichen für Zeichen UNVERÄNDERT (inkl. ```-Zeilen und aller Leerzeichen), niemals weglassen oder zusammenfassen — und erkläre danach kurz die Legende (Nummern/Buchstaben → Räume) sowie die Symbole (|=Nord/Süd, -=West/Ost, /=NO/SW, \\=NW/SO, ˄=hoch, ˅=runter).\n\n" +
    `Karte „${mv.area}":\n\`\`\`\n${mv.block}\n\`\`\``
  );
}

const contentToTextLocal = (resp: { content: unknown }) => (typeof resp.content === "string" ? resp.content : "");

function parseRouteQuery(q: string): { from: string; to: string } | null {
  if (!routeIntentCue(q)) return null;
  const strip = (s: string) =>
    s.replace(/^(the|a|an|dem|der|das|den|die|einem|einer|ein|zur|zum|ich|bitte)\s+/i, "")
      .replace(/\b(ausgang|ausgan|tor|eingang)\s+von\s+/i, "")
      // German questions often trail the verb/filler: "… zu Mupuk komme/gelange/hin".
      .replace(/\s+(komme|komm|gelange|gelangen|laufe|laufen|gehe|gehen|finde|hinkomme|hin|kommt|komme\s+ich|denn|bitte|ich)\b[\s\S]*$/i, "")
      .trim();
  // German "von X nach/zu Y", German "weg nach Y von X", English "from X to Y".
  let m = /\b(?:von|vom)\s+(.+?)\s+(?:nach|zu|zum|zur|bis\s+zu[m]?)\s+(.+?)[?.!]*\s*$/i.exec(q);
  if (m) return { from: strip(m[1]), to: strip(m[2]) };
  m = /\bweg\s+(?:nach|zu[m]?|zur)\s+(.+?)\s+(?:von|vom|ab)\s+(.+?)[?.!]*\s*$/i.exec(q);
  if (m) return { from: strip(m[2]), to: strip(m[1]) };
  m = /\bfrom\s+(.+?)\s+to\s+(.+?)[?.!]*\s*$/i.exec(q);
  if (m) return { from: strip(m[1]), to: strip(m[2]) };
  return null;
}

/**
 * Conversation-aware route-intent extraction (fallback when the single-message
 * regex can't parse it, e.g. "Bitte gib mir den Weg." after the places were
 * named earlier, or non-German phrasing). The LLM reads the recent turns and
 * returns rough from/to — language-agnostic.
 */
async function extractRouteIntentLLM(
  llm: ChatOllama,
  convo: string,
): Promise<{ from: string; to: string } | null> {
  const sys = new SystemMessage(
    "Erkenne, ob der Nutzer nach einem WEG/einer Route zwischen zwei Orten oder Räumen fragt — auch wenn sich die Frage über mehrere Nachrichten verteilt (z. B. Orte früher genannt, jetzt nur „gib mir den Weg“) und unabhängig von der Sprache. " +
      'Wenn ja, gib Start und Ziel als kurze Ortsnamen zurück: {"from":"…","to":"…"}. Sonst: {"none":true}. Antworte ausschließlich mit JSON.',
  );
  const usr = new HumanMessage(`Gesprächsverlauf (neueste Nachricht zuletzt):\n${convo}`);
  try {
    const resp = await llm.invoke([sys, usr]);
    const text = typeof resp.content === "string" ? resp.content : "";
    const obj = extractJsonObject(text);
    if (!obj || obj.none || !obj.from || !obj.to) return null;
    return { from: String(obj.from), to: String(obj.to) };
  } catch (err) {
    console.error("[route] LLM intent extraction failed:", err);
    return null;
  }
}

/** Pull the first JSON object out of an LLM reply (tolerates ```fences / <think>). */
function extractJsonObject(s: string): any | null {
  let cleaned = s.replace(/<think>[\s\S]*?<\/think>/g, "");
  // qwen3 (think:false) often emits its reasoning followed by a LONE </think>,
  // then the JSON answer. The reasoning itself can contain braces (it "drafts"
  // the JSON), so a greedy first-{-to-last-} match captures garbage. Cut to
  // after the last </think>, then take the LAST flat {...} object (the answer).
  const ti = cleaned.lastIndexOf("</think>");
  if (ti !== -1) cleaned = cleaned.slice(ti + "</think>".length);
  const flat = [...cleaned.matchAll(/\{[^{}]*\}/g)];
  for (let i = flat.length - 1; i >= 0; i--) { try { return JSON.parse(flat[i][0]); } catch { /* keep scanning */ } }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
  return null;
}

/**
 * Let the LLM resolve which exact rooms the user means, given the candidate
 * pages' room legends. Returns the chosen page + EXACT room names, or null if
 * the model can't place both endpoints (→ caller refuses, never fabricates).
 */
async function resolveRouteEndpoints(
  llm: ChatOllama,
  query: string,
  rq: { from: string; to: string },
  cand: RouteCandidates,
): Promise<{ page: string; from: string; to: string } | null> {
  const lists = cand.pages
    .map((p) => `[Karte: ${p.page}]\n${p.rooms.map((r) => `- ${r}`).join("\n")}`)
    .join("\n\n");
  const sys = new SystemMessage(
    "Du ordnest eine Wegfrage exakten Räumen aus vorgegebenen Kartenlisten zu. " +
      "Wähle Start- und Zielraum NUR aus den unten gelisteten Raumnamen (exakt, inkl. Klammern). " +
      "Beide müssen zur SELBEN Karten-Seite (page) gehören; sie dürfen aber in verschiedenen Teilkarten/Gebieten dieser Seite liegen. " +
      "Wähle die Seite, auf der BEIDE Orte als echte Räume DERSELBEN Reise vorkommen. So entscheidest du: " +
      "(1) Kommt ein Start- oder Zielname WÖRTLICH als Raum auf einer Karte vor (z.B. „Westtor von Tadmor“), bevorzuge diese Karte stark. " +
      "(2) Eine Straße/ein Weg, der nur NACH einem Ort benannt ist (z.B. „Borsippa-Straße“ mitten in einer anderen Stadt), ist NICHT dieser Ort. " +
      "Nennt der Nutzer ein Gebiet als Ziel (z.B. „Borsippa“), bevorzuge die Karte mit dem tatsächlichen Übergang/Tor dorthin (z.B. „Osttor von Borsippa“), nicht die gleichnamige Straße. " +
      "(3) Der Gebiets-Hinweis betrifft meist den STARTort – lass dich davon nicht zu einem falschen Ziel verleiten. " +
      "(4) Start und Ziel sind nur UNGEFÄHR angegeben und können Tipp-/Rechtschreibfehler enthalten (z.B. „hafne“ für „Hafen“, „westtro“ für „Westtor“). Ordne sie nach Bedeutung/Klang dem passenden Raumnamen zu; eine kleine Abweichung ist KEIN Grund für einen Fehler. " +
      "Wenn du Start oder Ziel nicht sicher zuordnen kannst, gib einen Fehler zurück. " +
      'Antworte ausschließlich mit JSON: {"page":"<conceptId>","from":"<exakter Raumname>","to":"<exakter Raumname>"} oder {"error":"..."}.',
  );
  const usr = new HumanMessage(
    `Frage: "${query}"\nGesuchter Start (ungefähr): "${rq.from}"\nGesuchtes Ziel (ungefähr): "${rq.to}"` +
      `${cand.hint ? `\nGebiets-Hinweis: ${cand.hint}` : ""}\n\nVerfügbare Karten und Räume:\n${lists}`,
  );
  try {
    const resp = await llm.invoke([sys, usr]);
    const text = typeof resp.content === "string" ? resp.content : "";
    const obj = extractJsonObject(text);
    if (!obj || obj.error || !obj.page || !obj.from || !obj.to) return null;
    return { page: String(obj.page), from: String(obj.from), to: String(obj.to) };
  } catch (err) {
    console.error("[route] LLM endpoint resolution failed:", err);
    return null;
  }
}

/** Build the compiled LangGraph app bound to a vector store, catalog and nav index. */
export function buildGraph(store: HNSWLib | null, catalog?: CatalogIndex | null, nav?: NavIndex | null, hybrid?: HybridSearch | null) {
  const llm = new ChatOllama({
    model: config.chatModel,
    baseUrl: config.ollamaBaseUrl,
    // qwen3:30b-a3b keeps reasoning regardless of this flag, and @langchain/ollama
    // merges Ollama's separate `thinking` field back into `content`. With
    // think:false the reasoning is at least delimited by a literal </think> we can
    // strip (here for non-streaming; server.ts filters the streaming path on it).
    think: false,
  });

  /** retrieve: find KB documents for the latest user question. */
  async function retrieve(state: State): Promise<Partial<State>> {
    const last = [...state.messages].reverse().find((m) => m.getType() === "human");
    const question =
      state.question ?? (typeof last?.content === "string" ? last.content : "");
    // Clients like Qwen Code prepend large system/tool context to the prompt,
    // which can exceed the embedding model's context window. Use only the tail
    // of the message as the retrieval query.
    const query = question.slice(-config.maxQueryChars);

    // Exact-title lookups via the catalog: when the query names a real page,
    // inject that whole page so we don't rely on the embedder to surface an
    // exact term. Disambiguation/"Sammelseite" hubs expand to their concrete
    // subpages; for each primary page we also pull a few 1-hop neighbours
    // (linked pages, e.g. the location/Gegend) as short supporting excerpts.
    const exactDocs: Document[] = [];
    const seen = new Set<string>();

    const addPage = async (e: CatalogEntry, full: boolean) => {
      if (seen.has(e.conceptId)) return;
      // Read generously, then keep more for map/area pages (ASCII maps + the
      // room legend are large and otherwise truncated out of context).
      const raw = await readPageBody(e.conceptId, 16000);
      if (!raw) return;
      const isMap = /Nord\/Süd|˄|˅|o--o|```|Hoch.*Runter/.test(raw);
      const body = !full
        ? raw.slice(0, 600)
        : isMap
          ? raw
          : raw.slice(0, 2500);
      seen.add(e.conceptId);
      let content = `${e.title}\n\n${body}`;
      const members = catalog!.categoryMembers(e);
      if (members.length) {
        const names = members
          .slice(0, 60)
          .map((id) => catalog!.getByConceptId(id)?.title ?? id);
        content += `\n\nEinträge in dieser Kategorie: ${names.join(", ")}`;
      }
      exactDocs.push(
        new Document({
          pageContent: content,
          metadata: { title: e.title, conceptId: e.conceptId, source: "exact" },
        }),
      );
    };

    if (catalog) {
      for (const hit of catalog.resolveTitlesInQuery(query)) {
        // Hub/disambiguation page → use its concrete subpages instead.
        const primaries = catalog.isDisambiguation(hit)
          ? catalog.variantsOf(hit)
          : [hit];
        if (primaries.length === 0) primaries.push(hit);
        for (const p of primaries) await addPage(p, true);
        // 1-hop neighbours (linked places/items) as short context, capped.
        let added = 0;
        for (const p of primaries) {
          for (const n of catalog.neighbors(p)) {
            if (added >= 3) break;
            if (seen.has(n.conceptId)) continue;
            await addPage(n, false);
            added++;
          }
        }
      }
    }

    // Listing/overview queries ("alle Rätsel", "welche Gilden gibt es") →
    // inject the full category member list from the catalog.
    const wantsList =
      /\b(alle|sämtliche|saemtliche|liste|auflisten|list|welche|übersicht|uebersicht|gibt es|jede[nrs]?)\b/i.test(
        query,
      );
    if (catalog && wantsList) {
      const injectCategory = (name: string, members: string[]) => {
        const catId = `__cat__/${name}`;
        if (seen.has(catId)) return;
        const titles = members
          .map((id) => catalog.getByConceptId(id))
          .filter((e): e is CatalogEntry => !!e && e.namespace !== 14) // skip sub-categories
          .map((e) => e.title)
          .sort((a, b) => a.localeCompare(b, "de"));
        if (!titles.length) return;
        const cap = 250;
        let content = `Kategorie „${name}" — ${titles.length} Einträge:\n${titles
          .slice(0, cap)
          .join(", ")}`;
        if (titles.length > cap) content += `\n… und ${titles.length - cap} weitere.`;
        exactDocs.push(
          new Document({
            pageContent: content,
            metadata: { title: `Kategorie: ${name}`, conceptId: catId, source: "category" },
          }),
        );
        seen.add(catId);
      };

      // A) deterministic: category name / compound alias appears in the query.
      const det = catalog.resolveCategoriesInQuery(query);
      for (const { name, members } of det) injectCategory(name, members);

      // B) semantic: embed the query and pull the cosine-nearest categories,
      // so "Pflichträtsel" still finds "Rätsel/Pflicht" even without an alias.
      if (store && catalog.semanticReady && det.length < 2) {
        try {
          const qv = await store.embeddings.embedQuery(query);
          // single confident match only — keeps B a precise booster, not a
          // source of noisy/wrong category lists.
          for (const { name, members } of catalog.nearestCategories(qv, 1, 0.66)) injectCategory(name, members);
        } catch (err) {
          console.error("[retrieve] semantic category lookup failed:", err);
        }
      }
    }

    // Routing: the LLM resolves which exact rooms the user means (its strength —
    // "der Laden mit dem Drachen" → "Laden (Drache)"), then the PATH is computed
    // in code and injected as authoritative. The model must relay the computed
    // directions verbatim and never invent a way.
    let routeComputed = false;
    if (nav) {
      let rq = parseRouteQuery(query);
      // Fallback: route intent that the regex can't parse from one message
      // (multi-turn "gib mir den Weg", or non-German phrasing) → ask the LLM,
      // giving it the recent conversation so earlier-named places are resolved.
      if (!rq && routeIntentCue(query)) {
        const convo = state.messages
          .slice(-6)
          .map((m) => `${m.getType() === "human" ? "Nutzer" : "Assistent"}: ${typeof m.content === "string" ? m.content : ""}`)
          .join("\n")
          .slice(-2000);
        rq = await extractRouteIntentLLM(llm, convo);
      }
      if (rq) {
        // Deterministic resolution ONLY when unambiguous (one shared page, one
        // room each — e.g. "Brückentor"→"Mupuk"). The moment several pages/rooms
        // plausibly match (e.g. "Borsippa" = the area vs. a "Borsippa-Straße"
        // tile), hand the choice to the LLM with full candidate context instead
        // of letting substring matching grab something arbitrary. The LLM also
        // decides which endpoint is start vs. destination.
        let r: RouteResult = await nav.resolveAndRoute(rq.from, rq.to);
        if (!r.ok) {
          const cand = nav.routeCandidates(rq.from, rq.to);
          if (cand.pages.length) {
            const picked = await resolveRouteEndpoints(llm, query, rq, cand);
            if (picked) {
              const lr = await nav.routeByNames(picked.page, picked.from, picked.to);
              if (lr.ok) r = lr;
            }
          }
        }
        routeComputed = r.ok;
        exactDocs.unshift(
          new Document({
            pageContent: r.ok
              ? formatRoute(r)
              : `BERECHNETER WEG: nicht verfügbar. Antworte sinngemäß genau so (ohne diese Klammer): „Einen genauen Weg von „${rq.from}" nach „${rq.to}" kann ich dir nicht zuverlässig angeben. Wenn du möchtest, zeige ich dir die Karte." Erfinde KEINEN Weg und KEINE Richtungen.`,
            metadata: { title: "Wegberechnung", conceptId: "__route__", source: "route" },
          }),
        );
      }
    }

    // Map display: the LLM decides the user wants a map and of WHICH area (even
    // a turn after one was offered), and picks the exact sub-map from gathered
    // candidates; the code renders that ASCII deterministically. Same AI-resolves
    // / code-renders split as routing — no brittle phrase/area string matching.
    let mapView = "";
    if (nav && !routeComputed) {
      const convo = state.messages
        .slice(-6)
        .map((m) => `${m.getType() === "human" ? "Nutzer" : "Assistent"}: ${typeof m.content === "string" ? m.content : ""}`)
        .join("\n")
        .slice(-2000);
      if (mapIntentCue(convo)) {
        const mi = await extractMapIntentLLM(llm, convo);
        if (mi) {
          const cands = await nav.mapCandidates(mi.area);
          const picked = cands.length ? await resolveMapView(llm, query, mi.area, cands) : null;
          const mv = picked ? await nav.renderNamedMap(picked.page, picked.anchor) : null;
          if (mv) {
            mapView = formatMapView(mv);
            exactDocs.unshift(
              new Document({
                pageContent: mapView,
                metadata: { title: "Kartenanzeige", conceptId: "__map__", source: "map" },
              }),
            );
          }
        }
      }
    }

    // Domain synonyms: expand the retrieval query so colloquial terms surface
    // the right section even for plain (non-route) questions. "Hafen" = the
    // harbour's Kurstafel/Hafengebiet (the ship-course board landing).
    let searchQuery = query;
    if (/hafen/i.test(query)) searchQuery += " Kurstafel Hafengebiet Steg";

    // Hybrid/BM25 retrieval when available; plain vector as a last resort.
    const ranked = hybrid
      ? await hybrid.search(searchQuery, config.topK)
      : store
        ? await store.similaritySearch(searchQuery, config.topK)
        : [];
    // When a route was computed, IT is the answer. Keep only a little extra
    // context so the model doesn't latch onto competing wiki prose (e.g. "Der Weg
    // zum Hafen führt durch das Osttor") and ignore the BERECHNETER WEG.
    const vectorDocs = ranked.filter((d) => !seen.has(d.metadata?.conceptId));
    // Down-rank the buyable "Karte/<Ort>" paper-map ITEM pages: when someone asks
    // for "die Karte von Tadmor" they mean the area page's Stadtplan, not the
    // item stub (which BM25 ranks high on its literal "Karte/…" title and which
    // the nav parser can't even read). Sink them below the real pages; keep the
    // route/category docs (non-"Karte/" titles) in place.
    const isKarteItem = (d: Document) => /^Karte\//.test(d.metadata?.title ?? "");
    const sink = (arr: Document[]) => [...arr.filter((d) => !isKarteItem(d)), ...arr.filter(isKarteItem)];
    const documents = [...sink(exactDocs), ...sink(vectorDocs)];
    // A computed route is surfaced to `generate` as a high-priority system
    // directive (above the CONTEXT). The directive also maps the resolved room
    // names back to the user's terms, so the model relays the route instead of
    // refusing on a name mismatch or paraphrasing competing wiki prose — which
    // means we can keep the full wiki context for colour alongside the route.
    const route = routeComputed ? exactDocs[0].pageContent : "";
    return { question, documents, context: formatContext(documents), route, mapView };
  }

  /** generate: call qwen3 with system prompt + context + trimmed history. */
  async function generate(state: State): Promise<Partial<State>> {
    // Keep the window bounded for multi-turn context management.
    const history = await trimMessages(state.messages, {
      maxTokens: config.maxHistoryMessages,
      strategy: "last",
      tokenCounter: (msgs) => msgs.length,
      includeSystem: false,
      startOn: "human",
    });

    // A computed route is authoritative — put it in the system instruction ABOVE
    // the CONTEXT so the model relays it verbatim instead of paraphrasing wiki
    // prose ("der Weg führt durch das Osttor").
    const routeDirective = state.route
      ? `VERBINDLICHE WEGAUSKUNFT: Der folgende BERECHNETE WEG IST die Antwort auf die aktuelle Frage des Nutzers. ` +
        `Start und Ziel wurden bereits auf die offiziellen Kartennamen der vom Nutzer gemeinten Orte aufgelöst – auch wenn diese Namen anders lauten als in der Frage (z. B. „Hafen" = „Steg (Kurstafel)", „Westtor von Tadmor" = „Westtor (Stadtwache …)"). Behandle sie als dieselben Orte. ` +
        `Gib GENAU diese Richtungen als kommagetrennte Liste wieder, samt \`tue\`-Befehl falls vorhanden. ` +
        `PFLICHT: Enthält der WEG einen Abschnitt „Kartenausschnitt des Weges:" mit einem in \`\`\` eingefassten Codeblock, MUSST du diesen Codeblock vollständig und Zeichen für Zeichen unverändert (inklusive der \`\`\`-Zeilen und aller Leerzeichen) mit ausgeben. Lass ihn NIEMALS weg und fasse ihn nicht zusammen. ` +
        `Erfinde oder ergänze KEINE Schritte und verweigere die Auskunft NICHT:\n${state.route}\n\n`
      : "";
    // A requested map is likewise authoritative — the resolved ASCII sub-map IS
    // the answer; the model must reproduce its code block verbatim.
    const mapDirective = state.mapView ? `VERBINDLICHE KARTENANZEIGE:\n${state.mapView}\n\n` : "";
    const messages: BaseMessage[] = [
      new SystemMessage(`${SYSTEM_PROMPT}\n\nCONTEXT:\n${state.context}\n\n${routeDirective}${mapDirective}`),
      ...history,
    ];

    const response = await llm.invoke(messages);
    // Strip any leaked qwen3 reasoning. Some qwen3 builds (e.g. 30b-a3b) ignore
    // the `think: false` flag and still emit a <think>…</think> block — or just a
    // reasoning preamble terminated by a lone </think>. Keep only the answer.
    if (typeof response.content === "string") {
      response.content = response.content
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/^[\s\S]*?<\/think>/, "")
        .trim();
    }
    return { messages: [response] };
  }

  return new StateGraph(GraphState)
    .addNode("retrieve", retrieve)
    .addNode("generate", generate)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "generate")
    .addEdge("generate", END)
    .compile();
}

export { GraphState, AIMessage, HumanMessage };
