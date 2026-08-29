import assert from 'node:assert/strict';
import test from 'node:test';
import { fieldDiagnosticsStatus, shouldShowFieldDiagnosticsIndicator } from '../src/fieldRunDiagnostics.js';

test('field diagnostics UI exposes distinct off, on, and environment-forced states', () => {
  assert.equal(fieldDiagnosticsStatus({ enabled: false, activationSource: 'off' }), 'Desativado');
  assert.equal(fieldDiagnosticsStatus({ enabled: true, activationSource: 'cli' }), 'Ativado');
  assert.equal(fieldDiagnosticsStatus({ enabled: true, activationSource: 'environment' }), 'Ativado — forçado pelo ambiente');
});

test('field diagnostics indicator is visible only while a call is active', () => {
  assert.equal(shouldShowFieldDiagnosticsIndicator({ enabled: false, inCall: true }), false);
  assert.equal(shouldShowFieldDiagnosticsIndicator({ enabled: true, inCall: false }), false);
  assert.equal(shouldShowFieldDiagnosticsIndicator({ enabled: true, inCall: true }), true);
});
