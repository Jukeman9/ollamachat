# Fix: Code Block Text Visibility Issue

## Problem
Code blocks in the chat display black text on a dark/black background, making them invisible until highlighted.

## Root Cause
In `src/sidebarProvider.ts` (lines 816-835), the CSS for `pre` and `code` elements defines a `background` color but **no `color` (text) property**. This causes the text to inherit its color from parent elements, resulting in dark/black text that's invisible on the dark code block background.

## Solution
Add explicit `color` property using VS Code's theme-aware CSS variable `var(--vscode-editor-foreground)` to the `pre, code` CSS rule.

## File Modified
- `src/sidebarProvider.ts` (lines 817-821)
