import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { VariableRows } from '../components/VariableRows';
import { TemplateVariableDef } from '../types';

let latest: TemplateVariableDef[] = [];

function Harness() {
  const [vars, setVars] = useState<TemplateVariableDef[]>([
    { name: 'status', kind: 'choice', default: '', required: false, options: [] },
  ]);
  latest = vars;
  return <VariableRows variables={vars} onChange={setVars} />;
}

describe('VariableRows choice options', () => {
  it('lets commas and spaces be typed, and stores the parsed list', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Variable 1 options') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'started,' } });
    expect(input.value).toBe('started,');
    fireEvent.change(input, { target: { value: 'started, in progress, ' } });
    expect(input.value).toBe('started, in progress, ');
    fireEvent.change(input, { target: { value: 'started, in progress, done' } });

    expect(latest[0].options).toEqual(['started', 'in progress', 'done']);
  });
});
