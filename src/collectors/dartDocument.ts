import axios from 'axios';
import AdmZip from 'adm-zip';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const DART_DOCUMENT_URL = 'https://opendart.fss.or.kr/api/document.xml';

/** Claude 입력 토큰 제어용 본문 길이 상한 */
const MAX_CONTENT_CHARS = 12_000;

/** XML 선언의 encoding 속성을 보고 적절히 디코드 (euc-kr / utf-8) */
function decodeXmlBuffer(buf: Buffer): string {
  // 앞부분을 latin1로 떠서 인코딩 선언만 확인
  const head = buf.toString('latin1', 0, 200).toLowerCase();
  const isEucKr = head.includes('euc-kr') || head.includes('ksc5601');
  const encoding = isEucKr ? 'euc-kr' : 'utf-8';
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

/** DART XML 마크업을 제거하고 가독 텍스트만 추출 */
function extractText(xml: string): string {
  return xml
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ') // 모든 태그 제거
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CONTENT_CHARS);
}

/**
 * DART document.xml API로 공시 원문을 받아 plain text로 반환한다.
 * 응답은 ZIP(바이너리) → 내부 .xml 추출 → 태그 제거.
 * 실패 시 빈 문자열을 반환하여 호출측이 제목/메타만으로 진행하게 한다 (graceful fallback).
 */
export async function fetchDisclosureText(rceptNo: string): Promise<string> {
  try {
    const res = await axios.get<ArrayBuffer>(DART_DOCUMENT_URL, {
      params: { crtfc_key: env.dartApiKey, rcept_no: rceptNo },
      responseType: 'arraybuffer',
      timeout: 15_000,
    });

    const buf = Buffer.from(res.data);

    // ZIP 시그니처(PK) 확인
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      logger.warn(`DART document [${rceptNo}] ZIP 아님 — 본문 없이 진행`);
      return '';
    }

    const zip = new AdmZip(buf);
    const xmlEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.xml'));
    if (!xmlEntry) {
      logger.warn(`DART document [${rceptNo}] XML 엔트리 없음 — 본문 없이 진행`);
      return '';
    }

    const xml = decodeXmlBuffer(xmlEntry.getData());
    return extractText(xml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`DART document [${rceptNo}] 본문 확보 실패 — 본문 없이 진행:`, msg);
    return '';
  }
}
