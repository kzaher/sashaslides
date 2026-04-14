#!/usr/bin/env python3
"""Inline the styles.css into each slide HTML file and normalize class names."""
import os
import re
import glob

SLIDES_DIR = os.path.dirname(os.path.abspath(__file__))
CSS_FILE = os.path.join(SLIDES_DIR, 'styles.css')

with open(CSS_FILE) as f:
    css_content = f.read()

# Class name mappings: subagents used inconsistent names
CLASS_FIXES = {
    'class="header"': 'class="slide-header"',
    'class="body"': 'class="slide-body"',
    'class="footer"': 'class="slide-footer"',
    'class="body two-col"': 'class="slide-body two-col"',
    'class="body centered"': 'class="slide-body centered"',
    'class="title-content"': 'class="title-content"',  # keep
    'class="presenter-info"': 'class="meta"',
    'class="footer-left"': '',
    'class="footer-right"': 'class="page-num"',
}

for html_path in sorted(glob.glob(os.path.join(SLIDES_DIR, 'slide_*.html'))):
    with open(html_path) as f:
        content = f.read()

    # Replace <link rel="stylesheet" href="styles.css"> with inline <style>
    content = re.sub(
        r'<link\s+rel=["\']stylesheet["\']\s+href=["\']styles\.css["\']\s*/?>',
        f'<style>\n{css_content}\n</style>',
        content
    )

    # Fix class names
    for old, new in CLASS_FIXES.items():
        content = content.replace(old, new)

    # Fix divs that use "header" as a tag-like class but not slide-header
    content = re.sub(r'<div class="slide-header">\s*<h1>', '<div class="slide-header"><h1>', content)

    # Ensure all slides have proper viewport meta
    if '<meta name="viewport"' not in content:
        content = content.replace('<head>', '<head>\n    <meta name="viewport" content="width=960">')

    # Convert relative image paths to absolute for WRS rendering
    abs_parent = os.path.dirname(SLIDES_DIR)
    content = content.replace('../screenshot_', f'{abs_parent}/screenshot_')

    with open(html_path, 'w') as f:
        f.write(content)

    print(f'Processed: {os.path.basename(html_path)}')

print(f'\nDone. Processed {len(glob.glob(os.path.join(SLIDES_DIR, "slide_*.html")))} slides.')
