import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeInput } from './CodeInput';
import { Switch } from './Switch';
import { loadTurnstile, resetTurnstileLoader, TURNSTILE_SRC } from './turnstile';

function CodeHarness({ onComplete }: { onComplete?: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <>
      <CodeInput value={v} onChange={setV} onComplete={onComplete} />
      <output data-testid="out">{v}</output>
    </>
  );
}

describe('CodeInput', () => {
  it('advances focus as digits are typed and completes at six', () => {
    const done = vi.fn();
    render(<CodeHarness onComplete={done} />);
    const boxes = screen.getAllByRole('textbox');
    expect(boxes).toHaveLength(6);
    fireEvent.change(boxes[0] as HTMLInputElement, { target: { value: '4' } });
    expect(document.activeElement).toBe(boxes[1]);
    for (const [i, d] of ['2', '7', '1', '9', '3'].entries()) {
      fireEvent.change(boxes[i + 1] as HTMLInputElement, { target: { value: d } });
    }
    expect(screen.getByTestId('out').textContent).toBe('427193');
    expect(done).toHaveBeenCalledWith('427193');
  });
  it('accepts a pasted code and ignores non-digits', () => {
    render(<CodeHarness />);
    const first = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.paste(first, { clipboardData: { getData: () => '12-34 56' } });
    expect(screen.getByTestId('out').textContent).toBe('123456');
  });
  it('fills every box from one-time-code autofill into the first box', () => {
    render(<CodeHarness />);
    fireEvent.change(screen.getAllByRole('textbox')[0] as HTMLInputElement, { target: { value: '654321' } });
    expect(screen.getByTestId('out').textContent).toBe('654321');
  });
  it('backspace clears and moves back', () => {
    render(<CodeHarness />);
    const boxes = screen.getAllByRole('textbox');
    fireEvent.change(boxes[0] as HTMLInputElement, { target: { value: '12' } });
    fireEvent.keyDown(boxes[2] as HTMLInputElement, { key: 'Backspace' });
    expect(screen.getByTestId('out').textContent).toBe('1');
    expect(document.activeElement).toBe(boxes[1]);
  });
  it('rejects letters', () => {
    render(<CodeHarness />);
    fireEvent.change(screen.getAllByRole('textbox')[0] as HTMLInputElement, { target: { value: 'ab' } });
    expect(screen.getByTestId('out').textContent).toBe('');
  });
});

describe('Switch', () => {
  it('is a labelled switch that reports changes', () => {
    const onChange = vi.fn();
    render(<Switch label="Pause all new sign-ups" checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Pause all new sign-ups' });
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it('can be disabled', () => {
    render(<Switch label="Locked" checked disabled />);
    expect((screen.getByRole('switch', { name: 'Locked' }) as HTMLInputElement).disabled).toBe(true);
  });
});

describe('loadTurnstile', () => {
  afterEach(() => {
    resetTurnstileLoader();
    delete window.turnstile;
    for (const s of document.querySelectorAll('script')) s.remove();
  });
  it('adds the script once and resolves when the API appears', async () => {
    const p1 = loadTurnstile();
    const p2 = loadTurnstile();
    const scripts = document.querySelectorAll(`script[src="${TURNSTILE_SRC}"]`);
    expect(scripts).toHaveLength(1);
    window.turnstile = { render: () => 'w', reset: () => {}, remove: () => {} };
    await act(async () => {
      (scripts[0] as HTMLScriptElement).onload?.(new Event('load'));
    });
    await expect(p1).resolves.toBe(window.turnstile);
    await expect(p2).resolves.toBe(window.turnstile);
  });
  it('rejects and allows a retry when the script fails to load', async () => {
    const p = loadTurnstile();
    const s = document.querySelector('script') as HTMLScriptElement;
    s.onerror?.(new Event('error'));
    await expect(p).rejects.toThrow('turnstile-load');
    loadTurnstile().catch(() => {});
    expect(document.querySelectorAll(`script[src="${TURNSTILE_SRC}"]`)).toHaveLength(1);
  });
});
