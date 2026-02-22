import test from 'node:test';
import assert from 'node:assert/strict';

// Decision policy mirror test (kept explicit so behavior change is obvious).
function classify(decision) {
  if (decision.isErrorLoop && decision.confidence >= 0.95) return 'stop';
  if (decision.isErrorLoop && decision.confidence > 0.7 && decision.confidence < 0.95) return 'warn';
  return 'normal';
}

test('decision policy: stop at >=0.95', () => {
  assert.equal(classify({ isErrorLoop: true, confidence: 0.95 }), 'stop');
  assert.equal(classify({ isErrorLoop: true, confidence: 0.99 }), 'stop');
});

test('decision policy: warn at (0.7, 0.95)', () => {
  assert.equal(classify({ isErrorLoop: true, confidence: 0.71 }), 'warn');
  assert.equal(classify({ isErrorLoop: true, confidence: 0.94 }), 'warn');
});

test('decision policy: normal otherwise', () => {
  assert.equal(classify({ isErrorLoop: false, confidence: 1.0 }), 'normal');
  assert.equal(classify({ isErrorLoop: true, confidence: 0.7 }), 'normal');
});
