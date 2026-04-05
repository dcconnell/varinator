import * as vscode from 'vscode';

/**
 * Resolves a C# type name to a color hex code based on user configuration.
 * Implements fallback logic: exact match -> outer type match -> undefined.
 */
export class ColorResolver {
    private typeColors: Map<string, string>;

    constructor() {
        this.typeColors = new Map();
        this.loadConfig();
    }

    /**
     * Reload the color map from VS Code settings.
     */
    loadConfig(): void {
        const config = vscode.workspace.getConfiguration('varinator');
        const colors = config.get<Record<string, string>>('typeColors', {});

        this.typeColors.clear();
        for (const [typeName, color] of Object.entries(colors)) {
            this.typeColors.set(typeName, color);
        }
    }

    /**
     * Get the color for a type name, with fallback logic:
     * 1. Exact match (e.g. "List<string>")
     * 2. Outer type match (e.g. "List")
     * 3. undefined (no color configured)
     */
    getColorForType(typeName: string, outerTypeName: string): string | undefined {
        // 1. Exact match
        const exactColor = this.typeColors.get(typeName);
        if (exactColor) {
            return exactColor;
        }

        // 2. Try without nullable suffix
        if (typeName.endsWith('?')) {
            const nonNullable = typeName.slice(0, -1);
            const nonNullableColor = this.typeColors.get(nonNullable);
            if (nonNullableColor) {
                return nonNullableColor;
            }
        }

        // 3. Outer type fallback
        if (outerTypeName !== typeName) {
            const outerColor = this.typeColors.get(outerTypeName);
            if (outerColor) {
                return outerColor;
            }
        }

        // 4. Try Nullable<T> -> Nullable fallback
        const nullableMatch = typeName.match(/^Nullable<(.+)>$/);
        if (nullableMatch) {
            const innerType = nullableMatch[1];
            const innerColor = this.typeColors.get(innerType);
            if (innerColor) {
                return innerColor;
            }
            return this.typeColors.get('Nullable');
        }

        return undefined;
    }

    /**
     * Check if a type has a color configured.
     */
    hasColor(typeName: string): boolean {
        return this.typeColors.has(typeName);
    }

    /**
     * Get all configured type-color pairs.
     */
    getAllColors(): Map<string, string> {
        return new Map(this.typeColors);
    }
}
