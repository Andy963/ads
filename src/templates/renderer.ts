export class TemplateRenderer {
  static render(template: string, variables: Record<string, unknown>): string {
    let result = template;

    result = result.replace(/\{\{(\w+)\|([^}]*)\}\}/g, (_match, varName: string, defaultValue: string) => {
      const value = variables[varName];
      return value !== undefined && value !== null ? String(value) : defaultValue;
    });

    result = result.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
      const value = variables[varName];
      return value !== undefined && value !== null ? String(value) : `{{${varName}}}`;
    });

    return result;
  }

  static validate(template: string, variables: Record<string, unknown>): Record<string, unknown> {
    const requiredMatches = template.match(/\{\{(\w+)\}\}/g) ?? [];
    const defaultsMatches = template.match(/\{\{(\w+)\|[^}]*\}\}/g) ?? [];

    const required = new Set<string>();
    const withDefaults = new Set<string>();

    for (const match of requiredMatches) {
      const name = match.replace(/[{}]/g, "");
      required.add(name);
    }

    for (const match of defaultsMatches) {
      const name = match.replace(/\{\{|\|.*|\}\}/g, "");
      withDefaults.add(name);
    }

    for (const name of withDefaults) {
      required.delete(name);
    }

    const missing: string[] = [];
    for (const name of required) {
      if (!(name in variables)) {
        missing.push(name);
      }
    }

    return {
      valid: missing.length === 0,
      missing_variables: missing,
      required_variables: Array.from(required),
      optional_variables: Array.from(withDefaults),
      errors: missing.length === 0 ? [] : [`Missing required variables: ${missing.join(", ")}`],
    };
  }

  static extractVariables(template: string): string[] {
    const matches = template.match(/\{\{(\w+)(?:\|[^}]*)?\}\}/g) ?? [];
    const unique: string[] = [];
    for (const match of matches) {
      const name = match.replace(/\{\{|\|.*|\}\}/g, "");
      if (!unique.includes(name)) {
        unique.push(name);
      }
    }
    return unique;
  }
}
