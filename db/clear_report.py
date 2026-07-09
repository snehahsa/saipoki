"""Snapshot + HTML report shown before wiping saved data via /clear."""

from __future__ import annotations

import html
import json
import time
from datetime import datetime, timezone
from typing import Any

from db.clear_service import _CLEAR_TABLES, _list_tables
from db.connection import table_columns
from poke_registry import parse_vault
from quest_engine import parse_quest_progress
from xp_levels import level_progress


def _row_val(row: Any, key: str, default: Any = None) -> Any:
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return default


def _to_unix_ts(value: Any) -> int:
    """Normalize created_at/updated_at from unix int or SQLite datetime text."""
    if value is None or value == "":
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())

    text = str(value).strip()
    if not text:
        return 0
    if text.isdigit():
        return int(text)

    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        pass

    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
        try:
            dt = datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except ValueError:
            continue

    try:
        return int(float(text))
    except (TypeError, ValueError):
        return 0


def _wallet_from_user_id(telegram_id: str) -> str:
    tid = str(telegram_id or "")
    if tid.startswith("wallet:"):
        return tid[7:]
    return ""


def _kins_totals_by_user(conn: Any) -> dict[str, dict[str, int]]:
    existing = _list_tables(conn)
    if "kins_payments" not in existing:
        return {}

    rows = conn.execute(
        """
        SELECT telegram_id, status,
               COUNT(*) AS payment_count,
               COALESCE(SUM(amount_kins), 0) AS total_kins
        FROM kins_payments
        GROUP BY telegram_id, status
        """
    ).fetchall()

    out: dict[str, dict[str, int]] = {}
    for row in rows:
        tid = str(_row_val(row, "telegram_id", ""))
        if not tid:
            continue
        bucket = out.setdefault(
            tid,
            {
                "confirmed_kins": 0,
                "confirmed_count": 0,
                "pending_kins": 0,
                "pending_count": 0,
            },
        )
        status = str(_row_val(row, "status", ""))
        count = int(_row_val(row, "payment_count", 0) or 0)
        total = int(_row_val(row, "total_kins", 0) or 0)
        if status == "confirmed":
            bucket["confirmed_kins"] += total
            bucket["confirmed_count"] += count
        elif status == "pending":
            bucket["pending_kins"] += total
            bucket["pending_count"] += count
    return out


def _owned_skin_count(raw: Any) -> int:
    if not raw:
        return 0
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return 0
    return len(data) if isinstance(data, list) else 0


def build_clear_snapshot(conn: Any) -> dict[str, Any]:
    """Collect per-user stats and table row counts before DELETE."""
    existing = _list_tables(conn)
    user_cols = table_columns(conn, "users") if "users" in existing else set()
    kins_by_user = _kins_totals_by_user(conn)

    table_counts: dict[str, int] = {}
    for table in _CLEAR_TABLES:
        if table not in existing:
            continue
        row = conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()
        table_counts[table] = int(_row_val(row, "n", 0) or 0)

    players: list[dict[str, Any]] = []
    if "users" in existing:
        select_cols = [
            c
            for c in (
                "telegram_id",
                "username",
                "display_name",
                "skin",
                "balance",
                "vault",
                "quest_progress",
                "owned_skins",
                "stats_xp",
                "stats_battles",
                "stats_wins",
                "stats_losses",
                "stats_wagered",
                "vending_spins",
                "created_at",
                "updated_at",
            )
            if c in user_cols
        ]
        if not select_cols:
            select_cols = ["telegram_id"]
        order_col = "balance" if "balance" in user_cols else "telegram_id"
        rows = conn.execute(
            f"SELECT {', '.join(select_cols)} FROM users ORDER BY {order_col} DESC"
        ).fetchall()

        for row in rows:
            telegram_id = str(_row_val(row, "telegram_id", ""))
            quest = parse_quest_progress(_row_val(row, "quest_progress"))
            vault = parse_vault(_row_val(row, "vault"))
            wins = int(_row_val(row, "stats_wins", 0) or 0)
            xp = int(_row_val(row, "stats_xp", 0) or 0)
            prog = level_progress(wins, xp, quest)
            kins = kins_by_user.get(telegram_id, {})

            players.append(
                {
                    "telegram_id": telegram_id,
                    "display_name": str(_row_val(row, "display_name", "") or ""),
                    "username": str(_row_val(row, "username", "") or ""),
                    "wallet": _wallet_from_user_id(telegram_id),
                    "balance": int(_row_val(row, "balance", 0) or 0),
                    "cards": len(vault),
                    "kins_transferred": int(kins.get("confirmed_kins", 0)),
                    "kins_payments": int(kins.get("confirmed_count", 0)),
                    "kins_pending": int(kins.get("pending_kins", 0)),
                    "quest_steps": len(quest.get("completed_steps") or []),
                    "quests_cleared": len(quest.get("removed_quests") or []),
                    "xp": xp,
                    "level": int(prog.get("level", 0) or 0),
                    "level_title": str(prog.get("level_title", "") or ""),
                    "battles": int(_row_val(row, "stats_battles", 0) or 0),
                    "wins": wins,
                    "losses": int(_row_val(row, "stats_losses", 0) or 0),
                    "wagered": int(_row_val(row, "stats_wagered", 0) or 0),
                    "skins": _owned_skin_count(_row_val(row, "owned_skins")),
                    "skin": str(_row_val(row, "skin", "") or ""),
                    "vending_spins": int(_row_val(row, "vending_spins", 0) or 0),
                    "created_at": _to_unix_ts(_row_val(row, "created_at", 0)),
                    "updated_at": _to_unix_ts(_row_val(row, "updated_at", 0)),
                }
            )

    totals = {
        "players": len(players),
        "balance": sum(p["balance"] for p in players),
        "cards": sum(p["cards"] for p in players),
        "kins_transferred": sum(p["kins_transferred"] for p in players),
        "quest_steps": sum(p["quest_steps"] for p in players),
        "quests_cleared": sum(p["quests_cleared"] for p in players),
        "xp": sum(p["xp"] for p in players),
        "battles": sum(p["battles"] for p in players),
        "wins": sum(p["wins"] for p in players),
    }

    return {
        "generated_at": int(time.time()),
        "table_counts_before": table_counts,
        "players": players,
        "totals": totals,
    }


def _fmt_ts(ts: int) -> str:
    if not ts:
        return "—"
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""))


def render_clear_password_form(*, error: str = "") -> str:
    err = f'<p class="err">{_esc(error)}</p>' if error else ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clear saved data</title>
  <style>
    body {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 24px; background: #0f1419; color: #e7ecf3; }}
    .card {{ max-width: 420px; background: #1a2332; border: 1px solid #2d3a4f; border-radius: 8px; padding: 20px; }}
    h1 {{ font-size: 1.1rem; margin: 0 0 12px; }}
    p {{ color: #9fb0c7; line-height: 1.5; }}
    input, button {{ font: inherit; }}
    input {{ width: 100%; box-sizing: border-box; padding: 10px; margin: 8px 0 12px; border-radius: 6px; border: 1px solid #3d4f68; background: #0f1419; color: #e7ecf3; }}
    button {{ padding: 10px 14px; border: 0; border-radius: 6px; background: #c44; color: #fff; cursor: pointer; }}
    .err {{ color: #ff8f8f; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>Clear all saved data</h1>
    <p>Enter the admin password to view a full snapshot report, then wipe every saved row.</p>
    {err}
    <form method="post" action="/clear">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">View report &amp; clear</button>
    </form>
  </div>
</body>
</html>"""


def render_clear_report_html(
    snapshot: dict[str, Any],
    cleared: dict[str, int],
    *,
    wallet_sessions_cleared: bool = True,
) -> str:
    players = snapshot.get("players") or []
    totals = snapshot.get("totals") or {}
    generated = _fmt_ts(int(snapshot.get("generated_at") or 0))
    table_before = snapshot.get("table_counts_before") or {}

    rows_html = []
    for idx, player in enumerate(players, start=1):
        wallet = player.get("wallet") or "—"
        username = player.get("username") or "—"
        rows_html.append(
            f"""<tr>
  <td data-sort="{idx}">{idx}</td>
  <td data-sort="{_esc(player.get('display_name', ''))}">{_esc(player.get('display_name', ''))}</td>
  <td data-sort="{_esc(username)}">{_esc(username)}</td>
  <td data-sort="{_esc(wallet)}" class="mono">{_esc(wallet)}</td>
  <td data-sort="{int(player.get('balance', 0))}">{int(player.get('balance', 0)):,}</td>
  <td data-sort="{int(player.get('cards', 0))}">{int(player.get('cards', 0))}</td>
  <td data-sort="{int(player.get('kins_transferred', 0))}">{int(player.get('kins_transferred', 0)):,}</td>
  <td data-sort="{int(player.get('quest_steps', 0))}">{int(player.get('quest_steps', 0))}</td>
  <td data-sort="{int(player.get('quests_cleared', 0))}">{int(player.get('quests_cleared', 0))}</td>
  <td data-sort="{int(player.get('xp', 0))}">{int(player.get('xp', 0)):,}</td>
  <td data-sort="{int(player.get('level', 0))}">{int(player.get('level', 0))} <span class="muted">{_esc(player.get('level_title', ''))}</span></td>
  <td data-sort="{int(player.get('battles', 0))}">{int(player.get('battles', 0))}</td>
  <td data-sort="{int(player.get('wins', 0))}">{int(player.get('wins', 0))}</td>
  <td data-sort="{int(player.get('skins', 0))}">{int(player.get('skins', 0))}</td>
  <td data-sort="{int(player.get('vending_spins', 0))}">{int(player.get('vending_spins', 0))}</td>
  <td data-sort="{int(player.get('created_at', 0))}">{_esc(_fmt_ts(int(player.get('created_at', 0))))}</td>
</tr>"""
        )

    cleared_rows = []
    deleted_total = 0
    for table in _CLEAR_TABLES:
        if table not in cleared and table not in table_before:
            continue
        before = int(table_before.get(table, 0))
        count = int(cleared.get(table, 0))
        deleted_total += count
        cleared_rows.append(
            f"<tr><td>{_esc(table)}</td><td>{before:,}</td><td>{count:,}</td></tr>"
        )

    players_json = html.escape(json.dumps(players))

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clear report — Pokequest-cards</title>
  <style>
    :root {{ color-scheme: dark; }}
    body {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 0; background: #0b1017; color: #e8eef7; }}
    header, main {{ padding: 16px 20px; }}
    header {{ background: #121a26; border-bottom: 1px solid #243247; }}
    h1 {{ margin: 0 0 6px; font-size: 1.15rem; }}
    .sub {{ color: #8fa3be; margin: 0; }}
    .ok {{ color: #7dffa8; font-weight: 700; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; }}
    .stat {{ background: #151f2e; border: 1px solid #2a3950; border-radius: 8px; padding: 10px 12px; }}
    .stat b {{ display: block; font-size: 1.05rem; margin-top: 4px; }}
    .stat span {{ color: #8fa3be; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }}
    section {{ margin: 22px 0; }}
    h2 {{ font-size: 0.95rem; margin: 0 0 10px; color: #b9c9de; }}
    .table-wrap {{ overflow: auto; border: 1px solid #243247; border-radius: 8px; background: #101824; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 0.82rem; }}
    th, td {{ padding: 8px 10px; border-bottom: 1px solid #1c2838; text-align: left; white-space: nowrap; }}
    th {{ position: sticky; top: 0; background: #172131; color: #b7c8df; cursor: pointer; user-select: none; }}
    th:hover {{ background: #1d2a3d; }}
    th.sorted-asc::after {{ content: " ▲"; color: #7dffa8; }}
    th.sorted-desc::after {{ content: " ▼"; color: #7dffa8; }}
    tr:hover td {{ background: #141e2c; }}
    .mono {{ font-size: 0.75rem; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }}
    .muted {{ color: #7f93ad; }}
    .toolbar {{ display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }}
    .toolbar label {{ color: #8fa3be; font-size: 0.8rem; }}
    select, input[type="search"] {{ font: inherit; background: #0f1419; color: #e8eef7; border: 1px solid #31425c; border-radius: 6px; padding: 6px 8px; }}
  </style>
</head>
<body>
  <header>
    <h1>Database cleared</h1>
    <p class="sub">Snapshot captured at {generated} · <span class="ok">All saved rows deleted</span></p>
  </header>
  <main>
    <section>
      <h2>Summary (before wipe)</h2>
      <div class="grid">
        <div class="stat"><span>Players</span><b>{int(totals.get('players', 0)):,}</b></div>
        <div class="stat"><span>Total balance</span><b>{int(totals.get('balance', 0)):,}</b></div>
        <div class="stat"><span>Total cards</span><b>{int(totals.get('cards', 0)):,}</b></div>
        <div class="stat"><span>$KINS transferred</span><b>{int(totals.get('kins_transferred', 0)):,}</b></div>
        <div class="stat"><span>Quest steps done</span><b>{int(totals.get('quest_steps', 0)):,}</b></div>
        <div class="stat"><span>Quests cleared</span><b>{int(totals.get('quests_cleared', 0)):,}</b></div>
        <div class="stat"><span>Total XP</span><b>{int(totals.get('xp', 0)):,}</b></div>
        <div class="stat"><span>Battles / wins</span><b>{int(totals.get('battles', 0)):,} / {int(totals.get('wins', 0)):,}</b></div>
      </div>
    </section>

    <section>
      <h2>Players</h2>
      <div class="toolbar">
        <label>Sort
          <select id="sort-col">
            <option value="balance">Balance</option>
            <option value="kins_transferred">$KINS transferred</option>
            <option value="xp">XP</option>
            <option value="level">Level</option>
            <option value="cards">Cards</option>
            <option value="quest_steps">Quest steps</option>
            <option value="quests_cleared">Quests cleared</option>
            <option value="display_name">Display name</option>
            <option value="wallet">Wallet</option>
            <option value="created_at">Created</option>
          </select>
        </label>
        <label>Order
          <select id="sort-dir">
            <option value="desc">High → low</option>
            <option value="asc">Low → high</option>
          </select>
        </label>
        <label>Filter
          <input id="filter" type="search" placeholder="name, username, wallet…">
        </label>
      </div>
      <div class="table-wrap">
        <table id="players-table">
          <thead>
            <tr>
              <th data-col="index">#</th>
              <th data-col="display_name">Display name</th>
              <th data-col="username">Username</th>
              <th data-col="wallet">Wallet</th>
              <th data-col="balance">Balance</th>
              <th data-col="cards">Cards</th>
              <th data-col="kins_transferred">$KINS sent</th>
              <th data-col="quest_steps">Quest steps</th>
              <th data-col="quests_cleared">Quests cleared</th>
              <th data-col="xp">XP</th>
              <th data-col="level">Level</th>
              <th data-col="battles">Battles</th>
              <th data-col="wins">Wins</th>
              <th data-col="skins">Skins</th>
              <th data-col="vending_spins">Vends</th>
              <th data-col="created_at">Created</th>
            </tr>
          </thead>
          <tbody id="players-body">
            {"".join(rows_html) if rows_html else '<tr><td colspan="16">No players saved.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Tables cleared</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Table</th><th>Rows before</th><th>Rows deleted</th></tr></thead>
          <tbody>
            {"".join(cleared_rows) if cleared_rows else '<tr><td colspan="3">No tables matched.</td></tr>'}
            <tr><td><b>Total deleted</b></td><td></td><td><b>{deleted_total:,}</b></td></tr>
          </tbody>
        </table>
      </div>
      <p class="sub">Wallet login sessions cleared: {"yes" if wallet_sessions_cleared else "no"}</p>
    </section>
  </main>
  <script id="players-data" type="application/json">{players_json}</script>
  <script>
    const PLAYERS = JSON.parse(document.getElementById("players-data").textContent || "[]");
    const COL_INDEX = {{
      index: 0, display_name: 1, username: 2, wallet: 3, balance: 4, cards: 5,
      kins_transferred: 6, quest_steps: 7, quests_cleared: 8, xp: 9, level: 10,
      battles: 11, wins: 12, skins: 13, vending_spins: 14, created_at: 15
    }};
    const fmt = (n) => Number(n || 0).toLocaleString();
    const fmtTs = (ts) => {{
      if (!ts) return "—";
      const d = new Date(ts * 1000);
      return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
    }};

    function rowHtml(p, i) {{
      const wallet = p.wallet || "—";
      const username = p.username || "—";
      return `<tr>
        <td>${{i}}</td>
        <td>${{escapeHtml(p.display_name || "")}}</td>
        <td>${{escapeHtml(username)}}</td>
        <td class="mono">${{escapeHtml(wallet)}}</td>
        <td>${{fmt(p.balance)}}</td>
        <td>${{fmt(p.cards)}}</td>
        <td>${{fmt(p.kins_transferred)}}</td>
        <td>${{fmt(p.quest_steps)}}</td>
        <td>${{fmt(p.quests_cleared)}}</td>
        <td>${{fmt(p.xp)}}</td>
        <td>${{fmt(p.level)}} <span class="muted">${{escapeHtml(p.level_title || "")}}</span></td>
        <td>${{fmt(p.battles)}}</td>
        <td>${{fmt(p.wins)}}</td>
        <td>${{fmt(p.skins)}}</td>
        <td>${{fmt(p.vending_spins)}}</td>
        <td>${{fmtTs(p.created_at)}}</td>
      </tr>`;
    }}

    function escapeHtml(s) {{
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }}

    function renderPlayers() {{
      const col = document.getElementById("sort-col").value;
      const dir = document.getElementById("sort-dir").value;
      const q = (document.getElementById("filter").value || "").trim().toLowerCase();
      let list = PLAYERS.slice();
      if (q) {{
        list = list.filter((p) => {{
          const hay = [p.display_name, p.username, p.wallet, p.telegram_id].join(" ").toLowerCase();
          return hay.includes(q);
        }});
      }}
      list.sort((a, b) => {{
        const av = a[col] ?? "";
        const bv = b[col] ?? "";
        const an = Number(av), bn = Number(bv);
        const cmp = (Number.isFinite(an) && Number.isFinite(bn) && String(av) !== "" && String(bv) !== "")
          ? an - bn
          : String(av).localeCompare(String(bv), undefined, {{ numeric: true }});
        return dir === "asc" ? cmp : -cmp;
      }});
      const body = document.getElementById("players-body");
      body.innerHTML = list.length
        ? list.map((p, idx) => rowHtml(p, idx + 1)).join("")
        : '<tr><td colspan="16">No matching players.</td></tr>';
      document.querySelectorAll("#players-table th[data-col]").forEach((th) => {{
        th.classList.remove("sorted-asc", "sorted-desc");
        if (th.dataset.col === col) th.classList.add(dir === "asc" ? "sorted-asc" : "sorted-desc");
      }});
    }}

    document.getElementById("sort-col").addEventListener("change", renderPlayers);
    document.getElementById("sort-dir").addEventListener("change", renderPlayers);
    document.getElementById("filter").addEventListener("input", renderPlayers);
    document.querySelectorAll("#players-table th[data-col]").forEach((th) => {{
      th.addEventListener("click", () => {{
        const col = th.dataset.col;
        if (!col || col === "index") return;
        const sel = document.getElementById("sort-col");
        const dir = document.getElementById("sort-dir");
        if (sel.value === col) {{
          dir.value = dir.value === "asc" ? "desc" : "asc";
        }} else {{
          sel.value = col;
          dir.value = ["display_name", "username", "wallet", "created_at"].includes(col) ? "asc" : "desc";
        }}
        renderPlayers();
      }});
    }});
    renderPlayers();
    try {{
      const profileKeys = [
        "pokequest_profile_vault",
        "pokequest_guest_id",
        "pokequest_vault_unlocked",
        "pokequest_wallet_session",
        "pokequest_wallet_address",
      ];
      for (const key of profileKeys) {{
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      }}
      for (let i = localStorage.length - 1; i >= 0; i--) {{
        const k = localStorage.key(i);
        if (k && k.startsWith("pokequest_guest_server_backup:")) {{
          localStorage.removeItem(k);
        }}
      }}
    }} catch (_) {{}}
  </script>
</body>
</html>"""
