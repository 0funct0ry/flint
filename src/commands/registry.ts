export interface Command {
  id: string;
  title: string;
  category?: string;
  shortcut?: string;
  shortcutDisplay?: string;
  handler: () => void;
}

class CommandRegistry {
  private commands: Map<string, Command> = new Map();

  register(command: Command) {
    this.commands.set(command.id, command);
  }

  unregister(id: string) {
    this.commands.delete(id);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  getAll(): Command[] {
    return Array.from(this.commands.values());
  }

  execute(id: string) {
    const cmd = this.commands.get(id);
    if (cmd) {
      cmd.handler();
    } else {
      console.warn(`Command not found: ${id}`);
    }
  }
}

export const commandRegistry = new CommandRegistry();
