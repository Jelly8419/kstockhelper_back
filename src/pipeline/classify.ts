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

Publish only if the article contains a new fact that may help investors understand the company's business, earnings, risks, supply chain, regulation, production, customers, shareholder return, or major industry context.

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
