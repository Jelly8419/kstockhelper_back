import { CLAUDE_MODELS } from '../config/anthropic';
import { callClaudeJsonWithUsage, type ClaudeUsage } from './claudeJson';
import type { ClassificationResult } from '../types';

const CLASSIFY_SYSTEM = `You are a financial news classifier for K-Stock Helper.

K-Stock Helper provides short English news briefs for foreign investors who follow these Korean stocks:
- Samsung Electronics
- SK Hynix
- Hyundai Motor

Your task is to decide whether the provided Korean news article should be published on K-Stock Helper.

Important:
- Do not create a news summary.
- Do not translate the article.
- Do not provide investment advice.
- Only classify the article based on relevance and news value.
- Use the article title, description/snippet, and available text.
- Do not judge based on the title alone.
- If uncertain, choose "skip" for MVP.

Be STRICT. The bar for publishing is HIGH — only genuinely market-moving news.
We publish a small number of high-value briefs per day, not every related article.
When in doubt, choose "skip".

Publish ONLY if BOTH hold:
1. The company is the primary subject (see test below), AND
2. The article reports a MATERIAL, specific, verifiable NEW fact that could
   plausibly move the stock or change how investors value the business — e.g.
   a confirmed earnings figure, a signed contract with scale, a concrete capex
   or M&A decision, a guidance change, a regulatory action, a shareholder-return
   decision, or a confirmed major customer/supply event.

NOT material enough to publish (skip these even if on-topic and factually new):
- Incremental, routine, or already-known developments.
- Rumors, speculation, "expected to", "could", "reportedly considering".
- Analyst opinions/targets without a concrete new catalyst or reasoning.
- General industry/macro color that does not pin a specific impact on THIS company.
- Minor product/PR/marketing items with no financial weight.

confidence must reflect MATERIALITY, not topical relevance:
- 90-100: clearly market-moving, confirmed, specific (e.g. official earnings, signed deal).
- 80-89: material and concrete but secondary in impact.
- below 80: relevant but not clearly material → this maps to "skip".
Do not default to the mid-80s; spread the score by how material the fact actually is.

CRITICAL — primary subject test:
The company must be the PRIMARY SUBJECT of the article, not just mentioned.
If the company (or KOSPI / chip industry / earnings) appears only as an EXAMPLE,
backdrop, or supporting evidence for a different main topic — such as politics,
government policy, social commentary, inequality, opinion columns, or human-interest
stories — choose "skip", even when the company name, tickers, or strong numbers
(record earnings, KOSPI levels) appear many times in the body.
Ask: "Is this article ABOUT the company's business, or is the company just used to
illustrate someone else's story?" If the latter, skip.

Publishable categories: EARNINGS, CONTRACT, CUSTOMER, CAPEX, PRODUCTION, SHAREHOLDER_RETURN, M&A, REGULATION, LEGAL_RISK, PRODUCT_TECH, MACRO_DIRECT, SUPPLY_CHAIN, ANALYST_VIEW_WITH_REASON

Do not publish if mainly about: simple stock price movement, featured stock, analyst target only, market wrap, fund flow only, event/promotion, CSR, hiring, labor noise, community reaction, duplicate, too short, irrelevant, politics / elections / government approval ratings, opinion / political column, social commentary or inequality where the company is only an example

Return JSON only:
{
  "decision": "publish" | "skip",
  "related_stocks": ["Samsung Electronics" | "SK Hynix" | "Hyundai Motor"],
  "category": "EARNINGS" | "CONTRACT" | ...,
  "confidence": 0-100,
  "reason": "Short reason within 120 characters"
}`;

/** 게시 조건: decision=publish AND confidence>=80 AND related_stocks 1개 이상 */
export function shouldPublish(r: ClassificationResult): boolean {
  return r.decision === 'publish' && r.confidence >= 80 && (r.related_stocks?.length ?? 0) >= 1;
}

/** 뉴스 제목 + snippet을 분류한다. usage(토큰 사용량)를 함께 반환 — 비용 계측용. */
export async function classifyNews(input: {
  title: string;
  description: string;
}): Promise<{ result: ClassificationResult; usage: ClaudeUsage }> {
  const user = `Title: ${input.title}\n\nDescription/snippet: ${input.description}`;
  return callClaudeJsonWithUsage<ClassificationResult>({
    model: CLAUDE_MODELS.classify,
    system: CLASSIFY_SYSTEM,
    user,
    maxTokens: 512,
  });
}
