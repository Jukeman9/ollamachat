# Fix Context Indicator Tooltip Display

## Problem
The context indicator tooltip is not visible when hovering.

## Root Cause
**Line 528 in `src/sidebarProvider.ts`**: The `.context-indicator` has `overflow: hidden`, which clips the child `.context-tooltip` that is positioned above it (`bottom: 100%`).

## Fix
1. Remove `overflow: hidden` from `.context-indicator`
2. Add `overflow: hidden` to `.context-fill` to keep the circular gradient clipped
