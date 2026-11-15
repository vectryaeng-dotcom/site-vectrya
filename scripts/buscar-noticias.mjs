// Busca notícias dos feeds RSS/Atom listados em feeds.json e gera noticias.json.
// Sem dependências: roda com Node 18+ (usa fetch nativo).
import { readFile, writeFile } from "node:fs/promises";

const CONFIG = process.env.FEEDS_FILE || "feeds.json";
const SAIDA = process.env.SAIDA_FILE || "noticias.json";

const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodificar(txt = "") {
  return txt
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTIDADES[e.toLowerCase()] ?? m);
}

function limparHtml(txt = "") {
  return decodificar(decodificar(txt).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(bloco, nomes) {
  for (const nome of nomes) {
    const m = bloco.match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`, "i"));
    if (m) return m[1].trim();
  }
  return "";
}

function linkAtom(bloco) {
  const alt = bloco.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    || bloco.match(/<link[^>]*href=["']([^"']+)["']/i);
  return alt ? decodificar(alt[1]) : "";
}

function imagem(bloco) {
  const m = bloco.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i)
    || bloco.match(/<enclosure[^>]*type=["']image[^"']*["'][^>]*url=["']([^"']+)["']/i)
    || bloco.match(/<enclosure[^>]*url=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i)
    || decodificar(bloco).match(/<img[^>]*src=["']([^"']+)["']/i);
  return m ? decodificar(m[1]) : "";
}

function resumo(txt, max = 180) {
  if (txt.length <= max) return txt;
  return txt.slice(0, txt.lastIndexOf(" ", max)).replace(/[,.;:]$/, "") + "…";
}

export function lerFeed(xml, fonte) {
  const blocos = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return blocos.map((b) => {
    const dataTxt = tag(b, ["pubDate", "published", "updated", "dc:date"]);
    const data = dataTxt ? new Date(decodificar(dataTxt)) : null;
    const link = limparHtml(tag(b, ["link"])) || linkAtom(b);
    return {
      titulo: limparHtml(tag(b, ["title"])),
      link,
      resumo: resumo(limparHtml(tag(b, ["description", "summary", "content:encoded", "content"]))),
      imagem: imagem(b),
      data: data && !isNaN(data) ? data.toISOString() : null,
      fonte: fonte.nome,
      categoria: fonte.categoria,
    };
  }).filter((n) => n.titulo && /^https?:\/\//.test(n.link));
}

async function buscar(fonte, limite) {
  try {
    const resp = await fetch(fonte.url, {
      headers: { "User-Agent": "Mozilla/5.0 (VectryaNoticiasBot)", Accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const itens = lerFeed(await resp.text(), fonte).slice(0, limite);
    console.log(`✔ ${fonte.nome}: ${itens.length} notícias`);
    return itens;
  } catch (e) {
    console.warn(`✖ ${fonte.nome} (${fonte.url}): ${e.message}`);
    return [];
  }
}

const porData = (a, b) => (b.data || "").localeCompare(a.data || "");

function semDuplicados(lista) {
  const vistos = new Set();
  return lista.filter((n) => {
    const chave = n.link.split("?")[0];
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG, "utf8"));
  const lim = cfg.limitePorFeed ?? 5;

  const setor = (await Promise.all((cfg.setor || []).map((f) => buscar(f, lim)))).flat();
  const news = (await Promise.all((cfg.newsletter || []).map((f) => buscar(f, lim)))).flat();

  // Se todos os feeds falharem, mantém o arquivo anterior em vez de apagar as notícias do site.
  let anterior = { setor: [], newsletter: [] };
  try { anterior = JSON.parse(await readFile(SAIDA, "utf8")); } catch {}

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    setor: setor.length
      ? semDuplicados(setor).sort(porData).slice(0, cfg.limiteTotalSetor ?? 9)
      : anterior.setor,
    newsletter: news.length
      ? semDuplicados(news).sort(porData).slice(0, cfg.limiteNewsletter ?? 3)
      : anterior.newsletter,
  };

  await writeFile(SAIDA, JSON.stringify(resultado, null, 2) + "\n");
  console.log(`Gerado ${SAIDA}: ${resultado.setor.length} do setor, ${resultado.newsletter.length} da newsletter.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
