#!/usr/bin/env python3
"""Generate The Crypt's biopsy pages, the Death Row tiles, and the junk leak archive.

    python3 tools/generate_biopsies.py                 # 9 biopsies, deadlines from today
    python3 tools/generate_biopsies.py --count 20 --expired 4 --seed 7
    python3 tools/generate_biopsies.py --base-date 2026-11-10

Writes (overwriting):
  website/biopsy-N/detailed-biopsy.html        one case file per biopsy
  website/index.html                           tiles between the BIOPSIES markers
  website/biopsy-E/files/<archive>.zip         junk "leak" for the expired biopsy

Everything is seeded: the same arguments always produce the same pages and the
same archive (byte for byte). Subjects are anonymous codenames + a generic
sector/region, except the named (fictitious) companies in tools/subjects.json,
which take over their `slot` with a full profile. The archive is random junk in a
Windows-looking folder tree, with a marker file saying it is simulated.
Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import datetime as dt
import hashlib
import html
import random
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "website"
BEGIN, END = "<!-- BIOPSIES:BEGIN -->", "<!-- BIOPSIES:END -->"

SECTORS = [
    "Healthcare", "Manufacturing", "Logistics", "Legal services", "Higher education",
    "Retail", "Construction", "Financial services", "Hospitality", "Agriculture",
    "Insurance", "Engineering", "Real estate", "Media", "Biotech", "Accounting",
    "Telecommunications", "Automotive", "Food processing", "Architecture",
]
REGIONS = ["North America", "Western Europe", "Central Europe", "APAC", "LATAM", "Nordics", "Middle East"]
FINDINGS = [
    "Domain admin credentials recovered from a plaintext share.",
    "Unpatched VPN appliance used as the initial access vector.",
    "Backups were online and reachable from the compromised domain.",
    "MFA not enforced for legacy mail protocols.",
    "Finance and HR shares exfiltrated in full.",
    "EDR tamper protection disabled across most endpoints.",
    "Service accounts with non-expiring passwords and broad rights.",
    "Flat network: no segmentation between office and server VLANs.",
    "Customer database exports found on a file server.",
    "Hypervisor management interface exposed internally without MFA.",
    "Revenue declined year over year; cyber insurance renewal pending.",
    "Board-level meeting minutes included in the dataset.",
    "Payroll records for the last three fiscal years copied.",
    "Engineering drawings and supplier contracts copied.",
]
NOTES = [
    "Negotiation window is open. Contact via the secure channel with your key.",
    "Sample files available to verified representatives on request.",
    "Publication proceeds automatically when the timer expires.",
    "Third parties named in the dataset will be notified at publication.",
]

# ------------------------------------------------------------------ helpers

def esc(s: str) -> str:
    return html.escape(s, quote=True)


def codename(rng: random.Random) -> str:
    return "SUBJ-" + "".join(rng.choice("0123456789ABCDEF") for _ in range(4))


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def make_subjects(count: int, expired: int, base: dt.datetime, rng: random.Random) -> list[dict]:
    seen, subjects = set(), []
    for n in range(1, count + 1):
        name = codename(rng)
        while name in seen:
            name = codename(rng)
        seen.add(name)
        if n == expired:
            deadline = base - dt.timedelta(days=3, hours=rng.randint(0, 20))
        else:
            deadline = base + dt.timedelta(days=rng.randint(7, 180), hours=rng.randint(0, 23),
                                           minutes=rng.randint(0, 59))
        subjects.append({
            "n": n,
            "code": name,
            "sector": rng.choice(SECTORS),
            "region": rng.choice(REGIONS),
            "employees": rng.choice([80, 120, 250, 400, 650, 900, 1500, 2400, 4000]),
            "revenue": rng.choice(["$12M", "$28M", "$45M", "$90M", "$140M", "$310M", "$650M", "$1.2B"]),
            "data_gb": rng.randint(40, 1800),
            "findings": rng.sample(FINDINGS, 3),
            "note": rng.choice(NOTES),
            "deadline": deadline.replace(microsecond=0),
            "expired": n == expired,
            "named": None,
        })
    return subjects


def apply_named(subjects: list[dict], named: list[dict], base: dt.datetime) -> None:
    for c in named:
        s = subjects[c["slot"] - 1]
        s.update({
            "named": c,
            "sector": c["sector"],
            "region": c["region"],
            "employees": c["employees"],
            "revenue": c["revenue"],
            "data_gb": c["data_gb"],
            "findings": c["findings"],
            "note": c["note"],
            "deadline": base + dt.timedelta(days=c["deadline_days"]),
            "expired": c["deadline_days"] <= 0,   # zero/negative = already published
        })

# ------------------------------------------------------------------ junk archive

WORDS = ("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor "
         "incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud "
         "exercitation ullamco laboris nisi aliquip ex ea commodo consequat").split()
BINARY_EXT = {".docx", ".xlsx", ".pdf", ".pptx", ".zip", ".bak", ".dat", ".lnk", ".db", ".pst", ".jpg", ".png", ".tmp"}


def junk_text(rng: random.Random, size: int) -> bytes:
    out, line = [], []
    total = 0
    while total < size:
        w = rng.choice(WORDS)
        line.append(w)
        total += len(w) + 1
        if len(line) > rng.randint(6, 14):
            out.append(" ".join(line))
            line = []
    out.append(" ".join(line))
    return ("\r\n".join(out)).encode()[:size]


def junk_csv(rng: random.Random, rows: int) -> bytes:
    lines = ["id,ref,lorem,ipsum,amount"]
    for i in range(rows):
        lines.append(f"{i+1},{rng.randint(10000, 99999)},{rng.choice(WORDS)},{rng.choice(WORDS)},{rng.randint(1, 99999)}.{rng.randint(0, 99):02d}")
    return ("\r\n".join(lines)).encode()


def junk_file(rng: random.Random, name: str) -> bytes:
    ext = Path(name).suffix.lower()
    if ext in BINARY_EXT:
        return rng.randbytes(rng.choice([2, 4, 8, 16, 24, 48, 96]) * 1024)
    if ext == ".csv":
        return junk_csv(rng, rng.randint(50, 600))
    return junk_text(rng, rng.randint(400, 12000))


def archive_tree(rng: random.Random) -> list[str]:
    users = ["Administrator", "svc_backup", "user01", "user02", "user03", "user04"]
    paths: list[str] = []
    for u in users:
        home = f"C$/Users/{u}"
        paths += [f"{home}/Desktop/{n}" for n in rng.sample(
            ["shortcut.lnk", "todo.txt", "notes.txt", "scan_0001.pdf", "draft.docx", "export.csv"], 3)]
        paths += [f"{home}/Documents/{n}" for n in rng.sample(
            ["Report_Q1.docx", "Report_Q2.docx", "Budget_DRAFT.xlsx", "Meeting_Notes.docx",
             "Presentation.pptx", "Contacts.csv", "Inventory.xlsx", "Proposal_v3.docx", "Invoice_000412.pdf",
             "Invoice_000413.pdf", "Timesheet.xlsx", "Policy.pdf"], 6)]
        paths += [f"{home}/Downloads/{n}" for n in rng.sample(
            ["setup.tmp", "archive.zip", "statement.pdf", "image_001.jpg", "image_002.png", "readme.txt"], 3)]
        paths.append(f"{home}/AppData/Roaming/Microsoft/Windows/Recent/recent_{rng.randint(100, 999)}.lnk")
        paths.append(f"{home}/AppData/Local/Temp/~tmp{rng.randint(1000, 9999)}.tmp")
        if u.startswith("user"):
            paths.append(f"{home}/AppData/Local/Microsoft/Outlook/{u}.pst")
    paths += [
        "C$/Users/Public/Documents/shared_notes.txt",
        "C$/Users/Public/Pictures/photo_001.jpg",
        "C$/ProgramData/App/config.ini",
        "C$/ProgramData/App/cache.db",
        "C$/Windows/Temp/install.log",
        "C$/Windows/Temp/~DF1A2B.tmp",
        "C$/Windows/Logs/CBS/CBS.log",
        "C$/Windows/System32/LogFiles/setup.log",
    ]
    for q in ("Q1", "Q2", "Q3", "Q4"):
        paths += [f"Shares/Finance/FY2025/{q}/{n}" for n in ("Ledger.xlsx", "Payables.csv", "Summary.pdf")]
    paths += [f"Shares/HR/Personnel/{n}" for n in ("Roster.xlsx", "Handbook.pdf", "Reviews_2025.docx", "Payroll_export.csv")]
    paths += [f"Shares/Legal/Contracts/Contract_{i:03d}.pdf" for i in rng.sample(range(1, 200), 8)]
    paths += [f"Shares/Engineering/Drawings/DWG-{rng.randint(1000, 9999)}.pdf" for _ in range(6)]
    paths += [f"Shares/IT/Backups/srv-fs01_{d}.bak" for d in ("20250901", "20251001", "20251101")]
    paths += ["Shares/IT/Scripts/cleanup.ps1", "Shares/IT/Scripts/map_drives.bat", "Shares/IT/inventory.csv"]
    return sorted(set(paths))


def build_archive(path: Path, label: str, rng: random.Random, stamp: dt.datetime) -> tuple[int, str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    tree = archive_tree(rng)
    marker = (f"{label} - SIMULATED DATA\r\n\r\nEvery file in this archive is randomly generated junk "
              "for threat emulation / training. It contains no real documents or personal data.\r\n").encode()
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        def add(name: str, data: bytes, when: dt.datetime) -> None:
            info = zipfile.ZipInfo(name, date_time=when.timetuple()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)
        add("_README_SIMULATED_DATA.txt", marker, stamp)
        for name in tree:
            when = stamp - dt.timedelta(days=rng.randint(1, 700), minutes=rng.randint(0, 1440))
            add(name, junk_file(rng, name), when)
    data = path.read_bytes()
    return len(data), hashlib.sha256(data).hexdigest(), len(tree) + 1

# ------------------------------------------------------------------ HTML

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="referrer" content="no-referrer">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{page_title}</title>
    <link href="/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="/font/bootstrap-icons.css" rel="stylesheet">
    <link href="/css/custom-styles.min.css" rel="stylesheet">
</head>
<body>
    <!-- Generated by tools/generate_biopsies.py; edit the generator, not this file. -->
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark">
        <div class="container">
            <a class="navbar-brand" href="/">The Crypt</a>
            <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
                <span class="navbar-toggler-icon"></span>
            </button>
            <div class="collapse navbar-collapse" id="navbarNav">
                <ul class="navbar-nav ms-auto">
                    <li class="nav-item"><a class="nav-link" href="/#deathRow">Death Row</a></li>
                    <li class="nav-item"><a class="nav-link" href="/#contact">Contact Us</a></li>
                    <li class="nav-item"><a class="nav-link" href="/chat/"><i class="bi bi-chat-dots"></i> Secure Channel</a></li>
                </ul>
            </div>
        </div>
    </nav>

    <section class="py-5"><div class="container text-center"><span class="section-tag">// Case File {code}</span></div>
        <div class="container">
            <h1 class="text-center mb-4">{heading}</h1>
            <div class="row">
                <div class="col-md-8 mx-auto review-body">
{profile}
                    <h3>Key Findings</h3>
                    <ul>
{findings}
                    </ul>
{extra}
                    <h3>Additional Notes</h3>
                    <p>{note}</p>
                </div>
            </div>
        </div>
    </section>

    <section class="py-5" id="timer-section">
        <div class="container text-center">
            <h2>{timer_heading}</h2>
            <p>{timer_text}</p>
            <div id="countdown" class="{countdown_class}" data-countdown="{deadline}">{countdown_initial}</div>
{download}
        </div>
    </section>

    <section id="contact" class="py-5 bg-light">
        <div class="container">
            <h2 class="text-center mb-4">Contact Me</h2>
            <div class="row justify-content-center">
                <div class="col-md-6">
                    <ul class="list-unstyled text-center">
                        <li class="mb-4">
                            <i class="bi bi-key"></i> Received a key? Open a private line to the operator:
                            <br>
                            <a href="/chat/" class="btn btn-primary mt-2"><i class="bi bi-chat-dots"></i> Secure Channel</a>
                        </li>
                        <li class="mb-3">
                            <i class="bi bi-currency-bitcoin"></i> Donate via Crypto:
                            <br>
                            <code>1AtCKUrZ3hGHH7ryPiEQ7pquqbSnjjMqFs</code> <!-- Replace with your address -->
                        </li>
                    </ul>
                </div>
            </div>
        </div>
    </section>

    <footer class="bg-dark text-white text-center py-4">
        <div class="container">
            <p>&copy; <span id="year"></span> The Crypt</p>
        </div>
    </footer>

    <script src="/dist/js/bootstrap.bundle.min.js"></script>
    <script src="/js/countdown.min.js"></script>
</body>
</html>
"""

DOWNLOAD = """            <div class="leak-download mt-4">
                <p class="text-secondary mb-3">The deadline passed. The dataset has been published.</p>
                <a class="btn btn-primary btn-lg" href="files/{file}" download><i class="bi bi-file-earmark-zip"></i> Download archive</a>
                <div class="small text-secondary mt-3 font-monospace">{file} &middot; {size} &middot; {files} files<br>SHA-256 {sha}</div>
            </div>"""

TILE = """                <div class="col-sm-6 col-lg-4">
                    <div class="card biopsy-tile mb-4 shadow-sm{tile_class}">
                        <div class="crypt-emblem">{emblem}</div>
                        <div class="card-body">
                            <h5 class="card-title">{title} <span class="status-tag">{status}</span></h5>
                            <p class="card-text small mb-2">{subtitle}</p>
                            <div class="tile-countdown{countdown_class}" data-countdown="{deadline}">{countdown_initial}</div>
                            <a href="biopsy-{n}/" class="btn btn-primary btn-sm mt-3 stretched-link">{button}</a>
                        </div>
                    </div>
                </div>"""


def profile_html(s: dict) -> tuple[str, str]:
    """(profile block, extra sections) for a case file."""
    c = s["named"]
    i = " " * 20
    if not c:
        return (f"{i}<p><strong>Subject:</strong> {esc(s['code'])} &mdash; {esc(s['sector'])}, {esc(s['region'])}.</p>\n"
                f"{i}<p><strong>Profile:</strong> ~{s['employees']} employees, annual revenue {esc(s['revenue'])}. "
                f"{s['data_gb']} GB of data recovered.</p>"), ""
    rows = [
        ("Company", esc(c["name"])),
        ("Website", f'<span class="font-monospace">{esc(c["domain"])}</span>'),
        ("Headquarters", "<br>".join(esc(line) for line in c["address"])),
        ("Industry", esc(c["sector"])),
        ("Employees", f"~{c['employees']}"),
        ("Revenue", esc(c["revenue"])),
        ("Data volume", f"{c['data_gb']} GB &middot; {esc(c['file_count'])} files"),
    ]
    table = "\n".join(f"{i}        <tr><th scope=\"row\">{k}</th><td>{v}</td></tr>" for k, v in rows)
    profile = (f"{i}<div class=\"subject-head\">\n"
               f"{i}    <div class=\"subject-mono\" aria-hidden=\"true\">{esc(c['monogram'])}</div>\n"
               f"{i}    <div><div class=\"subject-name\">{esc(c['name'])}</div>"
               f"<div class=\"subject-domain font-monospace\">{esc(c['domain'])}</div></div>\n"
               f"{i}</div>\n"
               f"{i}<p>{esc(c['summary'])}</p>\n"
               f"{i}<table class=\"table table-dark table-sm subject-table\">\n{i}    <tbody>\n{table}\n{i}    </tbody>\n{i}</table>")
    cats = "\n".join(f"{i}    <li>{esc(x)}</li>" for x in c["categories"])
    samples = "\n".join(esc(x) for x in c["samples"])
    extra = (f"{i}<h3>Data Obtained</h3>\n{i}<ul>\n{cats}\n{i}</ul>\n"
             f"{i}<h3>Proof &mdash; File Listing (excerpt)</h3>\n"
             f"{i}<pre class=\"proof-listing\">{samples}</pre>")
    return profile, extra


def render(subjects: list[dict]) -> None:
    # Remove stale biopsy folders beyond the new count.
    for old in WEB.glob("biopsy-*"):
        m = re.fullmatch(r"biopsy-(\d+)", old.name)
        if m and int(m.group(1)) > len(subjects) and old.is_dir():
            shutil.rmtree(old)

    tiles = []
    for s in subjects:
        iso = s["deadline"].strftime("%Y-%m-%dT%H:%M:%SZ")
        exp = s["expired"]
        download = ""
        archive = s.get("archive")
        if exp and archive:
            download = DOWNLOAD.format(file=esc(archive["file"]), size=human_size(archive["size"]),
                                       files=archive["files"], sha=archive["sha"])
        c = s["named"]
        profile, extra = profile_html(s)
        page = PAGE.format(
            n=s["n"], code=esc(s["code"]),
            page_title=esc(f"{c['short_name']} — Case File" if c else f"Biopsy {s['n']} Review"),
            heading=esc(c["name"]) if c else f"Detailed Review: Biopsy {s['n']}",
            profile=profile, extra=extra,
            findings="\n".join(f"                        <li>{esc(f)}</li>" for f in s["findings"]),
            note=esc(s["note"]),
            timer_heading="Time's up" if exp else "Countdown to Publication",
            timer_text="This subject did not come to the table." if exp else "Unless we hear from the subject, the data is published when the timer runs out:",
            countdown_class="expired" if exp else "",
            deadline=iso,
            countdown_initial="Time's up!" if exp else "--d --h --m --s",
            download=download,
        )
        d = WEB / f"biopsy-{s['n']}"
        d.mkdir(parents=True, exist_ok=True)
        (d / "detailed-biopsy.html").write_text(page)
        if not exp and (d / "files").exists():
            shutil.rmtree(d / "files")

        icon = "bi-file-earmark-zip" if exp else "bi-file-earmark-medical"
        tiles.append(TILE.format(
            n=s["n"],
            title=esc(c["short_name"]) if c else f"Biopsy {s['n']}",
            subtitle=(f"{esc(c['domain'])} &middot; {esc(c['sector'])} &middot; {esc(c['region'])}" if c
                      else f"{esc(s['code'])} &middot; {esc(s['sector'])} &middot; {esc(s['region'])}"),
            emblem=(f'<span class="subject-mono">{esc(c["monogram"])}</span>' if c else f'<i class="bi {icon}"></i>'),
            tile_class=(" expired" if exp else "") + (" named" if c else ""),
            status="Published" if exp else "Pending",
            countdown_class=" expired" if exp else "",
            deadline=iso,
            countdown_initial="Time's up!" if exp else "--d --h --m --s",
            button="Download data" if exp else "View Biopsy",
        ))

    index = WEB / "index.html"
    src = index.read_text()
    if BEGIN not in src or END not in src:
        raise SystemExit(f"index.html is missing the {BEGIN} / {END} markers")
    head, rest = src.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    index.write_text(head + BEGIN + "\n" + "\n".join(tiles) + "\n                " + END + tail)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--count", type=int, default=9)
    ap.add_argument("--expired", type=int, default=0,
                    help="make this codename slot run out of time (0 = none). Named companies "
                         "expire via deadline_days <= 0 in subjects.json")
    ap.add_argument("--subjects", default=str(ROOT / "tools" / "subjects.json"),
                    help="named fictitious companies (JSON); '' for none")
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument("--base-date", help="YYYY-MM-DD[THH:MM] (UTC) the deadlines count from (default: the current hour)")
    args = ap.parse_args()
    if not 1 <= args.count <= 500:
        raise SystemExit("--count must be 1..500")
    if not 0 <= args.expired <= args.count:
        raise SystemExit("--expired must be 0..count")

    # Deadlines count from the current hour (UTC) unless --base-date is given.
    base = (dt.datetime.fromisoformat(args.base_date).replace(tzinfo=None) if args.base_date
            else dt.datetime.now(dt.timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0))
    rng = random.Random(args.seed)
    subjects = make_subjects(args.count, args.expired, base, rng)
    named = json.loads(Path(args.subjects).read_text())["subjects"] if args.subjects else []
    for c in named:
        if not 1 <= c["slot"] <= args.count:
            raise SystemExit(f"{c['name']}: slot {c['slot']} is outside 1..{args.count}")
    apply_named(subjects, named, base)

    # Every expired subject gets its own junk archive (seeded per slot).
    for s in subjects:
        target = WEB / f"biopsy-{s['n']}" / "files"
        if target.exists():
            shutil.rmtree(target)
        if not s["expired"]:
            continue
        c = s["named"]
        stem = c["domain"].split(".")[0] if c else s["code"].lower()
        file = f"{stem}-dump.zip"
        label = c["name"] if c else s["code"]
        size, sha, files = build_archive(target / file, label, random.Random(args.seed + s["n"]), s["deadline"])
        s["archive"] = {"file": file, "size": size, "sha": sha, "files": files}

    render(subjects)
    print(f"Generated {args.count} biopsies (deadlines from {base:%Y-%m-%d %H:00} UTC).")
    for s in subjects:
        who = s["named"]["name"] if s["named"] else s["code"]
        state = "TIME'S UP" if s["expired"] else f"deadline {s['deadline']:%Y-%m-%d %H:%M} UTC"
        extra = ""
        if s.get("archive"):
            a = s["archive"]
            extra = f" -> files/{a['file']} ({human_size(a['size'])}, {a['files']} files)"
        print(f"  {s['n']:>2}. {who}: {state}{extra}")

if __name__ == "__main__":
    main()
