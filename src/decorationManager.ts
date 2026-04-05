import * as vscode from 'vscode';

export type HighlightStyle = 'foreground' | 'underline' | 'background' | 'border';

interface DecorationEntry {
    decorationType: vscode.TextEditorDecorationType;
    color: string;
    style: HighlightStyle;
}

/**
 * Manages VS Code text decorations for type-based variable coloring.
 * Creates and caches decoration types per color+style combination,
 * and applies them to editor ranges.
 */
export class DecorationManager {
    private decorationCache = new Map<string, DecorationEntry>();
    private activeDecorations = new Map<vscode.TextEditor, Map<string, vscode.Range[]>>();

    /**
     * Get or create a decoration type for the given color and style.
     */
    getDecorationType(color: string, style: HighlightStyle, config: {
        underlineWidth?: string;
        backgroundOpacity?: number;
    } = {}): vscode.TextEditorDecorationType {
        const cacheKey = `${color}|${style}|${config.underlineWidth ?? ''}|${config.backgroundOpacity ?? ''}`;

        const cached = this.decorationCache.get(cacheKey);
        if (cached) {
            return cached.decorationType;
        }

        let renderOptions: vscode.DecorationRenderOptions;

        switch (style) {
            case 'foreground':
                renderOptions = {
                    color: color,
                    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
                };
                break;

            case 'underline':
                renderOptions = {
                    textDecoration: `none; border-bottom: ${config.underlineWidth ?? '2px'} solid ${color}`,
                    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
                };
                break;

            case 'background': {
                const opacity = config.backgroundOpacity ?? 0.15;
                const bgColor = this.hexToRgba(color, opacity);
                renderOptions = {
                    backgroundColor: bgColor,
                    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
                };
                break;
            }

            case 'border':
                renderOptions = {
                    border: `1px solid ${color}`,
                    borderRadius: '3px',
                    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
                };
                break;
        }

        const decorationType = vscode.window.createTextEditorDecorationType(renderOptions);

        this.decorationCache.set(cacheKey, {
            decorationType,
            color,
            style
        });

        return decorationType;
    }

    /**
     * Apply decorations to an editor. Groups ranges by color to minimize
     * the number of decoration types applied.
     */
    applyDecorations(
        editor: vscode.TextEditor,
        rangesByColor: Map<string, vscode.Range[]>,
        style: HighlightStyle,
        config: {
            underlineWidth?: string;
            backgroundOpacity?: number;
        } = {}
    ): void {
        // Clear previous decorations for this editor
        this.clearDecorations(editor);

        const editorDecorations = new Map<string, vscode.Range[]>();

        for (const [color, ranges] of rangesByColor) {
            if (ranges.length === 0) {
                continue;
            }

            const decorationType = this.getDecorationType(color, style, config);
            editor.setDecorations(decorationType, ranges);
            editorDecorations.set(color, ranges);
        }

        this.activeDecorations.set(editor, editorDecorations);
    }

    /**
     * Clear all Varinator decorations from an editor.
     */
    clearDecorations(editor: vscode.TextEditor): void {
        const editorDecorations = this.activeDecorations.get(editor);
        if (editorDecorations) {
            // Clear all decoration types by setting empty ranges
            for (const [color] of editorDecorations) {
                for (const [, entry] of this.decorationCache) {
                    if (entry.color === color) {
                        editor.setDecorations(entry.decorationType, []);
                    }
                }
            }
            this.activeDecorations.delete(editor);
        }
    }

    /**
     * Clear all decorations from all editors.
     */
    clearAll(): void {
        for (const [editor] of this.activeDecorations) {
            this.clearDecorations(editor);
        }
    }

    /**
     * Dispose all decoration types.
     */
    dispose(): void {
        for (const [, entry] of this.decorationCache) {
            entry.decorationType.dispose();
        }
        this.decorationCache.clear();
        this.activeDecorations.clear();
    }

    /**
     * Force recreation of all decoration types (e.g. when style settings change).
     */
    invalidateCache(): void {
        this.dispose();
    }

    /**
     * Convert a hex color to rgba with the given opacity.
     */
    private hexToRgba(hex: string, opacity: number): string {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }
}
