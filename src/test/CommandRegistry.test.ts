import { describe, it, expect, vi } from 'vitest';
import { commandRegistry } from '../commands/registry';

describe('CommandRegistry', () => {
  it('registers, retrieves, and executes commands', () => {
    const handler = vi.fn();
    commandRegistry.register({
      id: 'test.command',
      title: 'Test Command',
      shortcut: '⌘T',
      handler,
    });

    const cmd = commandRegistry.get('test.command');
    expect(cmd).toBeDefined();
    expect(cmd?.title).toBe('Test Command');
    expect(cmd?.shortcut).toBe('⌘T');

    commandRegistry.execute('test.command');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('lists all registered commands', () => {
    const all = commandRegistry.getAll();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThan(0);
  });
});
