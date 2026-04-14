import os

TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=960">
<link rel="stylesheet" href="styles.css">
<style>
/* slide-specific styles */
</style>
</head>
<body>
<div class="slide">
  <div class="slide-header"><h1>{title}</h1></div>
  <div class="slide-body{body_class}">
{content}
  </div>
  <div class="slide-footer">
    <span>Gemini App Freshness and Response Quality</span>
    <span class="page-num">{page_num}</span>
  </div>
</div>
</body>
</html>"""

PEOPLE = {
    'robruenes': ('Rob Ruenes', 'SWE'),
    'vchtchetkine': ('Vladimir Chtchetkine', 'SWE'),
    'angsun': ('Angela Sun', 'Dir PM'),
    'haibinqi': ('Haibin Qi', 'SWE'),
    'ninamerlin': ('Nina Merlin', 'SWE Mgr'),
    'wmensah': ('Will Mensah', 'Eng Mgr'),
    'ckellner': ('Courtney Kellner', 'UX'),
    'benchesnut': ('Ben Chesnut', 'SWE'),
    'runningen': ('Jeff Runningen', 'SRE'),
    'mbrischke': ('Marvin Brischke', 'Partnerships'),
    'mrnagrath': ('Ankit Nagrath', 'Partnerships'),
    'egoregor': ('Egor Egorov', 'SWE'),
}

AVATAR_COLORS = ['#1a73e8', '#34a853', '#ea4335', '#fbbc04', '#8430ce', '#d93025', '#137333', '#174ea6', '#b06000', '#00796b', '#c62828', '#4527a0']

def _avatar_svg(username, size=48):
    # Check if PNG exists in photos directory
    png_path = f"photos/{username}.png"
    if os.path.exists(png_path):
        return f'<img src="{png_path}" width="{size}" height="{size}" style="border-radius: 50%; object-fit: cover;">'
        
    name = PEOPLE.get(username, (username, ''))[0]
    parts = name.split()
    initials = (parts[0][0] + parts[-1][0]).upper() if len(parts) > 1 else name[0].upper()
    color = AVATAR_COLORS[hash(username) % len(AVATAR_COLORS)]
    font_size = int(size * 0.42)
    return f'<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}"><circle cx="{size//2}" cy="{size//2}" r="{size//2}" fill="{color}"/><text x="{size//2}" y="{size//2 + font_size//3}" text-anchor="middle" fill="white" font-family="Google Sans,sans-serif" font-size="{font_size}" font-weight="500">{initials}</text></svg>'

def make_chips(usernames):
    chips = []
    for u in usernames:
        chips.append(f'<div style="display: inline-flex; align-items: center; background: #e8eaed; border-radius: 16px; padding: 2px 10px 2px 2px; font-size: 12px; margin-right: 6px; color: #3c4043;">{_avatar_svg(u, 20)}<span style="margin-left:6px;">@{u}</span></div>')
    return "".join(chips)

def make_profile(role, username):
    name = PEOPLE.get(username, (username, ''))[0]
    return f"""<div style="display: flex; flex-direction: column; align-items: center; text-align: center; min-width: 80px;">
        <div style="font-size: 11px; color: #5f6368; font-weight: 600; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">{role}</div>
        {_avatar_svg(username, 56)}
        <div style="font-size: 12px; color: #3c4043; font-weight: 500; margin-top: 4px;">{name}</div>
        <div style="font-size: 10px; color: #80868b;">@{username}</div>
      </div>"""

ICONS = {
    "done": '<svg viewBox="0 0 18 18" width="18" height="18" style="vertical-align: middle; margin-right: 8px; flex-shrink: 0;"><circle cx="9" cy="9" r="8" fill="#34a853"/><path d="M7.5 11.5l-3-3 .7-.7 2.3 2.3 4.3-4.3.7.7z" fill="#fff"/></svg>',
    "wip": '<svg viewBox="0 0 24 24" width="20px" height="20px" style="vertical-align: middle; margin-right: 8px;"><circle cx="12" cy="12" r="10" fill="#4285F4"/><path d="M11.99 6v6l4.25 2.52 1-1.6-3.25-1.92V6h-2z" fill="#FFF"/></svg>',
    "future": '<svg viewBox="0 0 24 24" width="20px" height="20px" style="vertical-align: middle; margin-right: 8px;"><circle cx="12" cy="12" r="10" fill="none" stroke="#9AA0A6" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="#9AA0A6"/></svg>',
    "unknown": '<svg viewBox="0 0 24 24" width="20px" height="20px" style="vertical-align: middle; margin-right: 8px;"><circle cx="12" cy="12" r="10" fill="#9AA0A6"/><text x="12" y="16" fill="#FFF" font-size="12" font-family="sans-serif" font-weight="bold" text-anchor="middle">?</text></svg>',
    "search": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48px" height="48px" style="margin-bottom:8px;"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
    "gemini": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48px" height="48px" style="margin-bottom:8px;"><path fill="#1A73E8" d="M24 2C24 13.6 34.4 24 46 24C34.4 24 24 34.4 24 46C24 34.4 13.6 24 2 24C13.6 24 24 13.6 24 2Z" /></svg>',
    "beaker": '<svg viewBox="0 0 24 24" width="24" height="24" style="vertical-align: middle; margin-right: 8px;"><path fill="currentColor" d="M19 20H5v-2h1.36l4.64-8V4h-1V2h8v2h-1v6l4.64 8H19v2zm-2.8-4l-3.2-5.5V4h-2v6.5L7.8 16h8.4z"/></svg>',
    "trend": '<svg viewBox="0 0 24 24" width="24" height="24" style="vertical-align: middle; margin-right: 8px;"><path fill="currentColor" d="M16 18l2.29-2.29-4.88-4.88-4 4L2 7.41 3.41 6l6 6 4-4 6.3 6.29L22 12v6z"/></svg>',
    "scales": '<svg viewBox="0 0 24 24" width="24" height="24" style="vertical-align: middle; margin-right: 8px;"><path fill="currentColor" d="M14 11V8h4v3h2V6h-6V3h-4v3H4v2h2v3H4v2h4v-2h4v2h4v-2h-2zm-8-3h4v3H6V8zm10 3V8h4v3h-4z"/></svg>',
    "target": '<svg viewBox="0 0 24 24" width="24" height="24" style="vertical-align: middle; margin-right: 8px;"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-13c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0 8c-1.65 0-3-1.35-3-3s1.35-3 3-3 3 1.35 3 3-1.35 3-3 3z"/></svg>',
    "clipboard": '<svg viewBox="0 0 24 24" width="20" height="20" style="vertical-align: middle; margin-right: 8px;"><path fill="currentColor" d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>',
    "palette": '<svg viewBox="0 0 24 24" width="20" height="20" style="vertical-align: middle; margin-right: 8px;"><path fill="currentColor" d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10c1.38 0 2.5-1.12 2.5-2.5 0-.61-.23-1.21-.64-1.67-.08-.09-.13-.21-.13-.33 0-.28.22-.5.5-.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 8 6.5 8 8 8.67 8 9.5 7.33 11 6.5 11zm3-4c-.83 0-1.5-.67-1.5-1.5S8.67 4 9.5 4 11 4.67 11 5.5 10.33 7 9.5 7zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 4 14.5 4 16 4.67 16 5.5 15.33 7 14.5 7zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 8 17.5 8 19 8.67 19 9.5 18.33 11 17.5 11z"/></svg>',
    "database": '<svg viewBox="0 0 24 24" width="20" height="20" style="vertical-align: middle; margin-right: 8px;"><path fill="currentColor" d="M12 2C6.48 2 2 4.02 2 6.5v11C2 19.98 6.48 22 12 22s10-2.02 10-4.5v-11C22 4.02 17.52 2 12 2zm0 3.5c3.54 0 6.53 1.13 8 2.5-1.47 1.37-4.46 2.5-8 2.5s-6.53-1.13-8-2.5c1.47-1.37 4.46-2.5 8-2.5zm0 14.5c-3.54 0-6.53-1.13-8-2.5v-2.18c1.45 1.05 4.39 1.68 8 1.68s6.55-.63 8-1.68V17.5c-1.47 1.37-4.46 2.5-8 2.5zm0-4.5c-3.54 0-6.53-1.13-8-2.5v-2.18c1.45 1.05 4.39 1.68 8 1.68s6.55-.63 8-1.68V13c-1.47 1.37-4.46 2.5-8 2.5z"/></svg>',
    "pen": '<svg viewBox="0 0 24 24" width="20" height="20" style="vertical-align: middle; margin-right: 8px;"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    "magnifier": '<svg viewBox="0 0 24 24" width="20" height="20" style="vertical-align: middle; margin-right: 8px;"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
    "film": '<svg viewBox="0 0 24 24" width="20" height="20" style="vertical-align: middle; margin-right: 8px;"><path fill="currentColor" d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>'
}

def make_diagram(signals, muted=False, show_unified_box=False, eta=""):
    opacity = "opacity: 0.5;" if muted else ""
    
    def get_style(status):
        if status == 'active':
            return "background: #e6f4ea; border: 1px solid #137333; color: #137333;"
        elif status == 'pending':
            return "background: #fef7e0; border: 1px solid #b06000; color: #b06000;"
        return "background: #f8f9fa; border: 1px solid #dadce0; color: #5f6368;"

    if show_unified_box:
        grouped_html = []
        ungrouped_html = []
        for name, status in signals:
            item = f'<div style="padding: 8px 16px; border-radius: 6px; font-size: 14px; font-weight: 500; {get_style(status)}">{name}</div>'
            if name == "QRBS.Resolve":
                ungrouped_html.append(item)
            else:
                grouped_html.append(item)
                
        box_css = "border: 2px dashed #1a73e8; border-radius: 8px; position: relative; padding: 12px;"
        label_html = '<div style="position:absolute; top:-10px; left:16px; background:white; padding:0 8px; color:#1a73e8; font-size:12px; font-weight:500;">Unified Signal Endpoint</div>'
        
        signal_content = f"""<div style="{box_css}">
        {label_html}
        <div style="display: flex; flex-direction: column; gap: 8px;">
          {''.join(grouped_html)}
        </div>
      </div>"""
        if ungrouped_html:
            signal_content += f"""<div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
        {''.join(ungrouped_html)}
      </div>"""
    else:
        signal_html = []
        for name, status in signals:
            signal_html.append(f'<div style="padding: 8px 16px; border-radius: 6px; font-size: 14px; font-weight: 500; {get_style(status)}">{name}</div>')
        signal_content = f"""<div style="display: flex; flex-direction: column; gap: 8px;">
        {''.join(signal_html)}
      </div>"""

    search_icon = ICONS['search']
    gemini_icon = ICONS['gemini']
    
    eta_badge = ""
    if eta:
        eta_badge = f'<div class="eta-badge" style="position: absolute; bottom: 0; right: 0; background: #1a73e8; color: white; padding: 6px 14px; border-radius: 16px; font-size: 13px; font-weight: 500;">{eta}</div>'
        
    return f"""<div style="display: flex; align-items: stretch; justify-content: space-between; margin: 20px 0; position: relative; {opacity}">
  <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 120px; flex-shrink: 0;">
    {search_icon}
    <div style="font-weight: 500; font-size: 14px; text-align: center;">Google Search</div>
  </div>
  <div style="flex: 1; display: flex; align-items: center;">
    <div style="flex: 1;"></div>
    <div style="width: 40px; height: 3px; background: #34a853;"></div>
    <div style="padding: 0 25px; flex-shrink: 0;">
      {signal_content}
    </div>
    <div style="width: 40px; height: 3px; background: #34a853;"></div>
    <div style="flex: 1;"></div>
  </div>
  <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 120px; flex-shrink: 0;">
    {gemini_icon}
    <div style="font-weight: 500; font-size: 14px; text-align: center;">Gemini App</div>
  </div>
  {eta_badge}
</div>"""

def generate_slides():
    slides = {}
    
    # Slide 5
    slides["slide_05_rtb_plan.html"] = TEMPLATE.format(
        title="Real-time signals for search: Short term plan - RTB",
        body_class=" two-col",
        page_num="5",
        content=f'''<div class="col" style="flex: 1.2;">
    {make_diagram([
        ("RealtimeBoostServlet", "active"),
        ("Hivemind", "inactive"),
        ("KomodoNavboost", "inactive"),
        ("World Context", "inactive"),
        ("Trends Signals", "inactive"),
        ("QRBS.Resolve", "inactive")
    ], eta="ETA 1 week")}
  </div>
  <div class="col" style="flex: 0.8; display: flex; flex-direction: column; justify-content: center;">
    <ul class="checklist" style="list-style: none; padding: 0; margin-top: 20px; font-size: 16px;">
      <li style="margin-bottom: 12px; display: flex; align-items: flex-start;">{ICONS['done']}<span>LE finished</span></li>
      <li style="margin-bottom: 12px; display: flex; align-items: flex-start;">{ICONS['done']}<span>Cost analysis done — Relative search triggering increase 0.04% overall</span></li>
      <li style="margin-bottom: 12px; display: flex; align-items: flex-start;">{ICONS['done']}<span>No statistically significant impact on TPU (per demand graph)</span></li>
      <li style="margin-bottom: 12px; display: flex; align-items: flex-start;">{ICONS['wip']}<span>Current status: Asking launch approval (<a href="#" style="color: #1a73e8; text-decoration: none;">go/geminiapp-rfc-3133</a>)</span></li>
    </ul>
  </div>'''
    )

    # Slide 6
    slides["slide_06_rtb_wl.html"] = TEMPLATE.format(
        title="Real-time signals for search: Short term plan - RTB W/L analysis",
        body_class=" two-col",
        page_num="6",
        content=f'''<div class="col" style="flex: 1.2;">
    {make_diagram([
        ("RealtimeBoostServlet", "active"),
        ("Hivemind", "inactive"),
        ("KomodoNavboost", "inactive"),
        ("World Context", "inactive"),
        ("Trends Signals", "inactive"),
        ("QRBS.Resolve", "inactive")
    ], eta="ETA 1 week")}
  </div>
  <div class="col" style="flex: 0.8; display: flex; flex-direction: column; justify-content: center;">
    <div class="card card-accent" style="border-left: 4px solid #34a853; background: #f8f9fa; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
      <h2 style="margin-top: 0; font-size: 20px;">Wins — Base misses relevant recent events</h2>
      <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 12px;">
        <div><div style="font-family: monospace; background: #e8eaed; padding: 4px 8px; border-radius: 4px; display: inline-block;">who is Gucci that is being kidnapped</div></div>
        <div><div style="font-family: monospace; background: #e8eaed; padding: 4px 8px; border-radius: 4px; display: inline-block;">who shot down the F-15 eject</div></div>
        <div><div style="font-family: monospace; background: #e8eaed; padding: 4px 8px; border-radius: 4px; display: inline-block;">Pooh shiesty arrest</div></div>
      </div>
    </div>
    <div class="card card-accent" style="border-left: 4px solid #34a853; background: #f8f9fa; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; align-items: center; justify-content: center;">
      <h2 style="margin-top: 0; font-size: 20px;">No Quality Losses</h2>
      <div style="font-size: 48px; margin-top: 16px;">{ICONS['done']}</div>
    </div>
  </div>'''
    )

    # Slide 7
    slides["slide_07_unified_signal.html"] = TEMPLATE.format(
        title="Real-time signals for search: Longer Term Plan Unified Freshness Signal",
        body_class=" two-col",
        page_num="7",
        content=f'''<div class="col" style="flex: 1.2;">
    {make_diagram([
        ("RealtimeBoostServlet", "active"),
        ("Hivemind", "active"),
        ("KomodoNavboost", "active"),
        ("World Context", "active"),
        ("Trends Signals", "active"),
        ("QRBS.Resolve", "pending")
    ], show_unified_box=True, eta="ETA 3.5 weeks")}
  </div>
  <div class="col" style="flex: 0.8; display: flex; flex-direction: column; justify-content: center;">
    <div style="padding: 10px;">
      <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px;">{ICONS['done']}<span>UnifiedSignal endpoint ready</span></div>
      <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px;">{ICONS['done']}<span>Calling RPC in Agency — code complete</span></div>
      <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px;">{ICONS['wip']}<span>Running LE — ETA today</span></div>
      <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px;">{ICONS['future']}<span>Logging unified signal LE — ETA 1 week</span></div>
      <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px;">{ICONS['future']}<span>Working E2E and triggering search LE — 2.5 weeks</span></div>
      <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px;">{ICONS['future']}<span>Launch — ETA 3.5 weeks</span></div>
      <div style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px;">{ICONS['future']}<span>RFC: WIP</span></div>
    </div>
    <div style="margin-top: 20px; font-size: 14px; color: #5f6368; display: flex; align-items: center;">
      Collaboration with {make_chips(['robruenes', 'vchtchetkine'])}
    </div>
  </div>'''
    )

    # Slide 8
    slides["slide_08_hivemind.html"] = TEMPLATE.format(
        title="Real-time signals for search: Optional - Using Short Term HiveMind Signals",
        body_class=" two-col",
        page_num="8",
        content=f'''<div class="col" style="flex: 1.2;">
    {make_diagram([
        ("RealtimeBoostServlet", "inactive"),
        ("Hivemind", "active"),
        ("KomodoNavboost", "inactive"),
        ("World Context", "inactive"),
        ("Trends Signals", "inactive"),
        ("QRBS.Resolve", "inactive")
    ], muted=True, eta="ETA ?")}
  </div>
  <div class="col" style="flex: 0.8; display: flex; flex-direction: column; justify-content: center;">
    <div class="card card-accent" style="border-left: 4px solid #1a73e8; background: #f8f9fa; border-radius: 8px; padding: 20px; text-align: center;">
      <h2 style="margin-top: 0;">Exploring using long-term HiveMind signals not covered by unified signal</h2>
      <p style="color: #5f6368; font-style: italic;">Needs reevaluation after unified signal experimentation</p>
    </div>
    <div style="margin-top: 20px; font-size: 14px; color: #5f6368; text-align: center; display: flex; align-items: center; justify-content: center;">
      Collaboration with {make_chips(['robruenes', 'vchtchetkine'])}
    </div>
  </div>'''
    )

    # Slide 9
    slides["slide_09_challenges.html"] = TEMPLATE.format(
        title="Real-time signals for search: Challenges",
        body_class="",
        page_num="9",
        content=f'''<div class="quadrant" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; height: 100%;">
  <div class="card risk-high" style="border-left: 4px solid #d93025; background: #fce8e6; border-radius: 8px; padding: 20px;">
    <h3 style="display: flex; align-items: center; color: #d93025; margin-top: 0;">{ICONS['beaker']} Evaluation Blocker</h3>
    <ul style="padding-left: 20px; color: #3c4043;">
      <li>inability to build a static ground-truth</li>
      <li>reliance on building a high-quality autorater</li>
    </ul>
  </div>
  <div class="card risk-medium" style="border-left: 4px solid #f29900; background: #fef7e0; border-radius: 8px; padding: 20px;">
    <h3 style="display: flex; align-items: center; color: #b06000; margin-top: 0;">{ICONS['trend']} Search Signal Degradation</h3>
    <ul style="padding-left: 20px; color: #3c4043;">
      <li>Quality depends on length</li>
      <li>Targeting 80% of prompts</li>
    </ul>
  </div>
  <div class="card risk-high" style="border-left: 4px solid #d93025; background: #fce8e6; border-radius: 8px; padding: 20px;">
    <h3 style="display: flex; align-items: center; color: #d93025; margin-top: 0;">{ICONS['scales']} Legal</h3>
    <ul style="padding-left: 20px; color: #3c4043;">
      <li>DMA 5(2)</li>
      <li>Using signals directly from Search</li>
      <li>Blocking logs evaluation</li>
    </ul>
  </div>
  <div class="card risk-medium" style="border-left: 4px solid #f29900; background: #fef7e0; border-radius: 8px; padding: 20px;">
    <h3 style="display: flex; align-items: center; color: #b06000; margin-top: 0;">{ICONS['target']} Small Targeted Slice</h3>
    <ul style="padding-left: 20px; color: #3c4043;">
      <li>< 0.1% of traffic</li>
      <li>Creates data mining and eval difficulty</li>
      <li>Disproportional reputational damage</li>
    </ul>
  </div>
</div>'''
    )

    # Slide 11
    slides["slide_11_max_search_results.html"] = TEMPLATE.format(
        title="Optimizations: Max Search Results from 20 to 10",
        body_class=" two-col",
        page_num="11",
        content=f'''<div class="col" style="flex: 1.5; display: flex; flex-direction: column; gap: 40px; justify-content: center;">
    <div style="display: flex; align-items: center; gap: 16px;">
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 80px;">
        {ICONS['search']}
      </div>
      <div style="font-size: 24px; color: #9aa0a6;">→</div>
      <div style="padding: 12px 20px; background: #f8f9fa; border: 1px solid #dadce0; border-radius: 6px; text-decoration: line-through; color: #d93025; font-weight: bold;">20 Results</div>
      <div style="font-size: 24px; color: #9aa0a6;">→</div>
      <div style="flex: 1; height: 80px; background: #e8eaed; border-radius: 6px; display: flex; align-items: stretch; border: 1px solid #dadce0;">
        <div style="width: 70%; background: #9aa0a6; border-radius: 6px 0 0 6px; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 14px;">LLM CONTEXT</div>
      </div>
    </div>
    
    <div style="display: flex; align-items: center; gap: 16px;">
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 80px;">
        {ICONS['search']}
      </div>
      <div style="font-size: 24px; color: #9aa0a6;">→</div>
      <div style="padding: 12px 20px; background: #e6f4ea; border: 1px solid #34a853; border-radius: 6px; color: #137333; font-weight: bold;">10 Results</div>
      <div style="font-size: 24px; color: #9aa0a6;">→</div>
      <div style="flex: 1; height: 80px; background: #e8eaed; border-radius: 6px; display: flex; align-items: stretch; border: 1px solid #dadce0;">
        <div style="width: 50%; background: #34a853; border-radius: 6px 0 0 6px; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; font-size: 14px;">LLM CONTEXT</div>
      </div>
    </div>
  </div>
  <div class="col" style="flex: 0.5; display: flex; flex-direction: column; justify-content: center; align-items: center;">
    <div style="background: #e6f4ea; color: #137333; padding: 6px 16px; border-radius: 16px; font-weight: bold; margin-bottom: 12px;">Launched</div>
    <div style="margin-bottom: 24px; font-size: 14px;"><a href="#" style="color: #1a73e8; text-decoration: none;">go/geminiapp-rfc-3062</a></div>
    <div style="text-align: center; background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 24px; width: 100%;">
      <div style="font-size: 36px; font-weight: bold; color: #1a73e8;">5.9K</div>
      <div style="font-size: 14px; color: #5f6368; text-transform: uppercase; margin-top: 8px;">GXUs Saved</div>
    </div>
    <div style="margin-top: 20px; font-size: 14px; color: #5f6368; display: flex; align-items: center;">
      Collaboration with {make_chips(['egoregor'])}
    </div>
  </div>'''
    )

    # Slide 12
    slides["slide_12_fast_path_current.html"] = TEMPLATE.format(
        title="Optimizations: Fast Path for freshness seeking prompts (Freshness slice)",
        body_class="",
        page_num="12",
        content='''<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
  <div style="width: 100%; border-radius: 8px; overflow: hidden; height: 180px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border: 1px solid #dadce0; display: flex; align-items: flex-start; justify-content: center;">
    <img src="../screenshot_7srD8L5Bx54WvQv.png" style="width: 100%; object-fit: cover; object-position: top;">
  </div>
</div>'''
    )

    # Slide 13
    slides["slide_13_fast_path_new.html"] = TEMPLATE.format(
        title="Optimizations: Fast Path for freshness seeking prompts (Freshness slice)",
        body_class="",
        page_num="13",
        content='''<div style="display: flex; flex-direction: column; align-items: center; gap: 24px; height: 100%;">
  <div style="width: 100%; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border: 1px solid #dadce0;">
    <img src="../screenshot_7srD8L5Bx54WvQv.png" style="width: 100%; display: block;">
  </div>
  <div style="display: flex; justify-content: space-between; width: 100%; gap: 16px;">
    <div style="flex: 1; text-align: center; background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 16px;">
      <div style="font-size: 28px; font-weight: bold; color: #1a73e8;">2.5K</div>
      <div style="font-size: 12px; color: #5f6368; text-transform: uppercase; margin-top: 4px;">GXUs Saved</div>
    </div>
    <div style="flex: 1; text-align: center; background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 16px;">
      <div style="font-size: 28px; font-weight: bold; color: #34a853;">-34%</div>
      <div style="font-size: 12px; color: #5f6368; text-transform: uppercase; margin-top: 4px;">p50 Fast</div>
    </div>
    <div style="flex: 1; text-align: center; background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 16px;">
      <div style="font-size: 28px; font-weight: bold; color: #34a853;">-12.91%</div>
      <div style="font-size: 12px; color: #5f6368; text-transform: uppercase; margin-top: 4px;">p50 Pro</div>
    </div>
  </div>
  <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
    <div style="background: #e8eaed; color: #5f6368; padding: 6px 16px; border-radius: 16px; font-weight: bold;">Approved (pending rampup)</div>
    <div style="font-size: 14px;"><a href="#" style="color: #1a73e8; text-decoration: none;">go/geminiapp-rfc-3115</a></div>
  </div>
</div>'''
    )

    # Slide 14
    slides["slide_14_fast_model_current.html"] = TEMPLATE.format(
        title="Optimizations: Fast Model for First Turn on Pro (Freshness slice)",
        body_class="",
        page_num="14",
        content='''<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
  <div style="width: 100%; border-radius: 8px; overflow: hidden; height: 180px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border: 1px solid #dadce0; display: flex; align-items: flex-start; justify-content: center;">
    <img src="../screenshot_7tDXMyXuK55TxqE.png" style="width: 100%; object-fit: cover; object-position: top;">
  </div>
</div>'''
    )

    # Slide 15
    slides["slide_15_fast_model_new.html"] = TEMPLATE.format(
        title="Optimizations: Fast Model for First Turn on Pro (Freshness slice)",
        body_class="",
        page_num="15",
        content='''<div style="display: flex; flex-direction: column; align-items: center; gap: 24px; height: 100%;">
  <div style="width: 100%; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border: 1px solid #dadce0;">
    <img src="../screenshot_7tDXMyXuK55TxqE.png" style="width: 100%; display: block;">
  </div>
  <div style="display: flex; justify-content: space-between; width: 100%; gap: 16px;">
    <div style="flex: 1; text-align: center; background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 16px;">
      <div style="font-size: 28px; font-weight: bold; color: #1a73e8;">617</div>
      <div style="font-size: 12px; color: #5f6368; text-transform: uppercase; margin-top: 4px;">GXUs Saved</div>
    </div>
    <div style="flex: 1; text-align: center; background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 16px;">
      <div style="font-size: 28px; font-weight: bold; color: #34a853;">-12%</div>
      <div style="font-size: 12px; color: #5f6368; text-transform: uppercase; margin-top: 4px;">p50</div>
    </div>
    <div style="flex: 1; text-align: center; background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 16px;">
      <div style="font-size: 28px; font-weight: bold; color: #34a853;">-15%</div>
      <div style="font-size: 12px; color: #5f6368; text-transform: uppercase; margin-top: 4px;">TPU</div>
    </div>
    <div style="flex: 1; text-align: center; background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 16px; display: flex; align-items: center; justify-content: center;">
      <div style="font-size: 18px; font-weight: bold; color: #5f6368;">Neutral quality</div>
    </div>
  </div>
  <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
    <div style="background: #e6f4ea; color: #137333; padding: 6px 16px; border-radius: 16px; font-weight: bold;">Approved (code complete)</div>
    <div style="font-size: 14px; text-align: center;">
      <a href="#" style="color: #1a73e8; text-decoration: none;">go/geminiapp-rfc-3116</a>, 
      <a href="#" style="color: #1a73e8; text-decoration: none;">go/geminiapp-rfc-3095</a>, 
      <a href="#" style="color: #1a73e8; text-decoration: none;">go/geminiapp-rfc-3132</a>
    </div>
  </div>
</div>'''
    )

    # Slide 16
    slides["slide_16_worldcup_overview.html"] = TEMPLATE.format(
        title="World Cup + Soccer Experience Overview",
        body_class=" two-col",
        page_num="16",
        content=f'''<div class="col" style="flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 20px;">
    <div style="border-left: 4px solid #1a73e8; background: #f8f9fa; padding: 16px; border-radius: 8px; border-top: 1px solid #dadce0; border-right: 1px solid #dadce0; border-bottom: 1px solid #dadce0;">
      <div style="font-weight: bold; margin-bottom: 8px; color: #1a73e8;">Bento Card</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <div style="height: 40px; background: #e8eaed; border-radius: 4px;"></div>
        <div style="height: 40px; background: #e8eaed; border-radius: 4px;"></div>
        <div style="height: 40px; background: #e8eaed; border-radius: 4px;"></div>
        <div style="height: 40px; background: #e8eaed; border-radius: 4px;"></div>
      </div>
    </div>
    <div style="border-left: 4px solid #34a853; background: #f8f9fa; padding: 16px; border-radius: 8px; border-top: 1px solid #dadce0; border-right: 1px solid #dadce0; border-bottom: 1px solid #dadce0;">
      <div style="font-weight: bold; margin-bottom: 8px; color: #137333;">Response</div>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div style="height: 12px; width: 100%; background: #e8eaed; border-radius: 2px;"></div>
        <div style="height: 12px; width: 80%; background: #e8eaed; border-radius: 2px;"></div>
        <div style="height: 12px; width: 90%; background: #e8eaed; border-radius: 2px;"></div>
      </div>
    </div>
    <div style="border-left: 4px solid #d93025; background: #f8f9fa; padding: 16px; border-radius: 8px; border-top: 1px solid #dadce0; border-right: 1px solid #dadce0; border-bottom: 1px solid #dadce0;">
      <div style="font-weight: bold; margin-bottom: 8px; color: #d93025;">Video</div>
      <div style="height: 120px; background: #3c4043; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
        <div style="width: 0; height: 0; border-top: 15px solid transparent; border-bottom: 15px solid transparent; border-left: 25px solid white;"></div>
      </div>
    </div>
  </div>
  <div class="col" style="flex: 1; position: relative;">
    <div style="position: absolute; right: -80px; top: 0; bottom: 0; opacity: 0.5; z-index: 1;">
      <img src="../screenshot_9qFHYWgiTJZg8NG.png" style="height: 100%; width: auto; object-fit: contain;">
    </div>
    <div style="position: relative; z-index: 2; height: 100%; display: flex; flex-direction: column; justify-content: center; padding-left: 20px;">
      <div style="background: rgba(255,255,255,0.9); padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; display: flex; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border: 1px solid #dadce0;">
        {ICONS['done']} <span style="font-weight: 500;">Card improvements Done</span>
      </div>
      <div style="background: rgba(255,255,255,0.9); padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; display: flex; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border: 1px solid #dadce0;">
        {ICONS['done']} <span style="font-weight: 500;">1P KG Done</span>
      </div>
      <div style="background: rgba(255,255,255,0.9); padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; display: flex; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border: 1px solid #dadce0;">
        {ICONS['wip']} <span style="font-weight: 500;">GenUI ETA next week</span>
      </div>
      <div style="background: rgba(255,255,255,0.9); padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; display: flex; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border: 1px solid #dadce0;">
        {ICONS['wip']} <span style="font-weight: 500;">Video ETA next week</span>
      </div>
      <div style="background: rgba(255,255,255,0.9); padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; display: flex; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border: 1px solid #dadce0;">
        {ICONS['future']} <span style="font-weight: 500;">Quality losses ETA 3 weeks</span>
      </div>
    </div>
  </div>'''
    )

    # Slide 18
    slides["slide_18_collaborations.html"] = TEMPLATE.format(
        title="World Cup: Collaborations",
        body_class="",
        page_num="18",
        content=f'''<div style="margin-top: 8px;">
  <div style="font-size: 14px; color: #3c4043; margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
    <span style="font-weight: 500;">New Mini Vertical Workstream — Collaboration with</span>
    {make_chips(['robruenes', 'vchtchetkine'])}
  </div>
  <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;">
    <div style="background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 12px; text-align: center;">
      <div style="font-size: 11px; color: #1a73e8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">PM</div>
      {_avatar_svg('angsun', 44)}
      <div style="font-size: 11px; color: #3c4043; font-weight: 500; margin-top: 4px;">Angela Sun</div>
      <div style="font-size: 10px; color: #80868b;">@angsun</div>
    </div>
    <div style="background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 12px; text-align: center;">
      <div style="font-size: 11px; color: #1a73e8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">UI</div>
      {_avatar_svg('haibinqi', 44)}
      <div style="font-size: 11px; color: #3c4043; font-weight: 500; margin-top: 4px;">Haibin Qi</div>
      <div style="font-size: 10px; color: #80868b;">@haibinqi</div>
    </div>
    <div style="background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 12px; text-align: center;">
      <div style="font-size: 11px; color: #1a73e8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">UX</div>
      {_avatar_svg('ckellner', 44)}
      <div style="font-size: 11px; color: #3c4043; font-weight: 500; margin-top: 4px;">Courtney Kellner</div>
      <div style="font-size: 10px; color: #80868b;">@ckellner</div>
    </div>
    <div style="background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 12px; text-align: center;">
      <div style="font-size: 11px; color: #1a73e8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">1P KG Data</div>
      <div style="display: flex; gap: 8px; justify-content: center;">
        <div>{_avatar_svg('ninamerlin', 40)}<div style="font-size: 10px; color: #3c4043; margin-top: 2px;">@ninamerlin</div></div>
        <div>{_avatar_svg('wmensah', 40)}<div style="font-size: 10px; color: #3c4043; margin-top: 2px;">@wmensah</div></div>
      </div>
    </div>
    <div style="background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 12px; text-align: center;">
      <div style="font-size: 11px; color: #1a73e8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">AIM PM</div>
      {_avatar_svg('angsun', 44)}
      <div style="font-size: 11px; color: #3c4043; font-weight: 500; margin-top: 4px;">Angela Sun</div>
      <div style="font-size: 10px; color: #80868b;">@angsun</div>
    </div>
    <div style="background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 12px; text-align: center;">
      <div style="font-size: 11px; color: #1a73e8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Search Classifiers</div>
      <div style="display: flex; gap: 8px; justify-content: center;">
        <div>{_avatar_svg('benchesnut', 40)}<div style="font-size: 10px; color: #3c4043; margin-top: 2px;">@benchesnut</div></div>
        <div>{_avatar_svg('runningen', 40)}<div style="font-size: 10px; color: #3c4043; margin-top: 2px;">@runningen</div></div>
      </div>
    </div>
    <div style="background: #f8f9fa; border: 1px solid #dadce0; border-radius: 8px; padding: 12px; text-align: center; grid-column: span 2;">
      <div style="font-size: 11px; color: #1a73e8; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Partnerships / Licensing Video from FIFA</div>
      <div style="display: flex; gap: 16px; justify-content: center;">
        <div>{_avatar_svg('mbrischke', 40)}<div style="font-size: 10px; color: #3c4043; margin-top: 2px;">@mbrischke</div></div>
        <div>{_avatar_svg('mrnagrath', 40)}<div style="font-size: 10px; color: #3c4043; margin-top: 2px;">@mrnagrath</div></div>
      </div>
    </div>
  </div>
</div>'''
    )

    for filename, html in slides.items():
        with open(filename, 'w') as f:
            f.write(html)
        print(f"Generated {filename}")

if __name__ == '__main__':
    generate_slides()
