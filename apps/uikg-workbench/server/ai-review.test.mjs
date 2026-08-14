import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAIReviews, normalizeAIReviewOutput } from './ai-review.mjs';

const elements = [
  { id: 'element-a', candidateKey: 'settings.row', reviewStatus: 'pending' },
  { id: 'element-b', candidateKey: 'settings.toggle', reviewStatus: 'accepted' },
];

test('AI 初审兼容常见字段别名并补齐缺失元素', () => {
  const normalized = normalizeAIReviewOutput({ reviews: [{
    candidate_key: 'settings.row',
    verdict: 'approved',
    score: 92,
    comment: '标签与边框匹配',
    risks: '边框仍需人工确认',
  }] }, elements, 'gpt-5.6-sol', '2026-08-14T00:00:00.000Z');
  assert.equal(normalized[0].review.status, 'pass');
  assert.equal(normalized[0].review.confidence, 0.92);
  assert.deepEqual(normalized[0].review.issues, ['边框仍需人工确认']);
  assert.equal(normalized[1].review.status, 'needs_review');
  assert.deepEqual(normalized[1].review.issues, ['missing-review-result']);
});

test('AI 初审不会代替人工修改 reviewStatus', () => {
  const reviews = normalizeAIReviewOutput({ elements: [
    { candidateKey: 'settings.row', status: 'pass', confidence: 0.9, summary: '通过', issues: [] },
    { candidateKey: 'settings.toggle', status: 'reject', confidence: 0.8, summary: '疑似重复', issues: ['duplicate'] },
  ] }, elements, 'gpt-5.6-sol');
  const draft = applyAIReviews({ revision: 4, elements, updatedAt: '' }, reviews);
  assert.equal(draft.revision, 5);
  assert.equal(draft.elements[0].reviewStatus, 'pending');
  assert.equal(draft.elements[1].reviewStatus, 'accepted');
  assert.equal(draft.elements[0].aiReview.status, 'pass');
  assert.equal(draft.elements[1].aiReview.status, 'reject');
});
