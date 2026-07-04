"""
analisis_ddos.py — Grafik DDoS dengan loader yang diperbaiki
Membaca format: Ringkasan sheet dengan kolom Metrik|Baseline|Saat HTTP Flood|Recovery
"""

import os, glob, warnings
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.gridspec as gridspec
from openpyxl import load_workbook
from datetime import datetime

warnings.filterwarnings('ignore')

# ── Warna & style ──────────────────────────────────────────────
ETH_COLOR   = '#2E4BC6'
FAB_COLOR   = '#CC4400'
PASS_COLOR  = '#1A8A4A'
FAIL_COLOR  = '#B22222'
WARN_COLOR  = '#B06800'
BG_DARK     = '#FFFFFF'
BG_PANEL    = '#F5F7FA'
TEXT_LIGHT  = '#1A1A2E'
TEXT_MID    = '#555577'
ACCENT_GOLD = '#D4620A'

plt.rcParams.update({
    'font.family':      'DejaVu Sans',
    'axes.facecolor':   BG_PANEL,
    'figure.facecolor': BG_DARK,
    'text.color':       TEXT_LIGHT,
    'axes.labelcolor':  TEXT_LIGHT,
    'xtick.color':      TEXT_MID,
    'ytick.color':      TEXT_MID,
    'axes.edgecolor':   '#AAAACC',
    'grid.color':       '#DDDDEE',
    'grid.linewidth':   0.6,
    'axes.grid':        True,
    'axes.titlecolor':  TEXT_LIGHT,
    'axes.titlesize':   13,
    'axes.titleweight': 'bold',
    'axes.labelsize':   10,
    'legend.facecolor': '#FFFFFF',
    'legend.edgecolor': '#AAAACC',
    'legend.labelcolor': TEXT_LIGHT,
})

OUTPUT_DIR = './hasil_grafik'
os.makedirs(OUTPUT_DIR, exist_ok=True)

UPLOAD_DIR = r'C:\Users\Acer\Downloads\TugasAkhir\testing-blockchain\analysis'

# ── Recovery time (detik) — dari hitungan manual terpisah ─────
# Selisih waktu dari health check terakhir saat serangan hingga
# health check pertama yang kembali normal. Sesuaikan jika ada
# angka baru / per-iterasi.
RECOVERY_TIME_SECONDS = {
    'fabric':   6.8,
    'ethereum': 38.2,
}


# ── Parser DDoS ──────────────────────────────────────────────
def parse_ddos_file(path):
    """
    Baca sheet Ringkasan dengan format:
    Row diawali '── NAMA SECTION ──' lalu baris-baris metrik di bawahnya.
    Setiap metrik disimpan PER SECTION agar tidak saling overwrite
    (karena 'Berhasil', 'Total Percobaan', 'Latency Avg (ms)' dst
    muncul berulang di banyak section).
    """
    wb = load_workbook(path, data_only=True)
    ws = wb['Ringkasan']

    def to_f(v):
        if v is None:
            return None
        try:
            return float(str(v).replace('%', '').replace(',', '.').strip())
        except:
            return None

    # data_by_section[section_name][metric_label] = [baseline, serangan, recovery]
    data_by_section = {}
    current_section = None

    for row in ws.iter_rows(values_only=True):
        label = str(row[0]).strip() if row[0] else ''
        if not label:
            continue
        if label.startswith('──'):
            # Header section, contoh: "── STORE DATA AKADEMIK ──"
            current_section = label.replace('──', '').strip()
            data_by_section[current_section] = {}
            continue
        if label.startswith('HASIL') or label == 'Metrik':
            continue
        if current_section is None:
            continue
        data_by_section[current_section][label] = [row[1], row[2], row[3]]

    def get(section, key, col):
        sec = data_by_section.get(section, {})
        v = sec.get(key)
        if v and col < len(v):
            return to_f(v[col])
        return None

    # col: 0=Baseline, 1=Saat HTTP Flood, 2=Recovery
    result = {
        'availability':       get('AVAILABILITY — Health Check', 'Availability (%)', 1),
        'avail_baseline':     get('AVAILABILITY — Health Check', 'Availability (%)', 0),
        'avail_recovery':     get('AVAILABILITY — Health Check', 'Availability (%)', 2),

        # Jumlah request health check mentah per fase (untuk anotasi "n=" di grafik)
        'hc_total_baseline':  get('AVAILABILITY — Health Check', 'Total Request', 0),
        'hc_total_serangan':  get('AVAILABILITY — Health Check', 'Total Request', 1),
        'hc_total_recovery':  get('AVAILABILITY — Health Check', 'Total Request', 2),
        'hc_ok_baseline':     get('AVAILABILITY — Health Check', 'Berhasil', 0),
        'hc_ok_serangan':     get('AVAILABILITY — Health Check', 'Berhasil', 1),
        'hc_ok_recovery':     get('AVAILABILITY — Health Check', 'Berhasil', 2),

        'latency_baseline':   get('AVAILABILITY — Health Check', 'Latency Avg (ms)', 0),
        'latency_serangan':   get('AVAILABILITY — Health Check', 'Latency Avg (ms)', 1),
        'latency_recovery':   get('AVAILABILITY — Health Check', 'Latency Avg (ms)', 2),

        'flood_total':        get('STATISTIK HTTP FLOOD', 'Total Request Flood', 1),
        'flood_ok':           get('STATISTIK HTTP FLOOD', 'Flood Berhasil (ok)', 1),
        'flood_error_rate':   get('STATISTIK HTTP FLOOD', 'Flood Error Rate (%)', 1),

        # Khusus Store Akademik — bukan ke-overwrite oleh Verify Hash lagi
        'store_akademik_berhasil': get('STORE DATA AKADEMIK', 'Berhasil', 1),
        'store_akademik_total':    get('STORE DATA AKADEMIK', 'Total Percobaan', 1),

        # Khusus Store Dokumen
        'store_dokumen_berhasil':  get('STORE DOKUMEN (PDF)', 'Berhasil', 1),
        'store_dokumen_total':     get('STORE DOKUMEN (PDF)', 'Total Percobaan', 1),

        # Khusus Read Data
        'read_berhasil':           get('READ DATA', 'Berhasil', 1),
        'read_total':              get('READ DATA', 'Total Percobaan', 1),
        'read_latency_baseline':   get('READ DATA', 'Latency Avg (ms)', 0),
        'read_latency_serangan':   get('READ DATA', 'Latency Avg (ms)', 1),
        'read_latency_recovery':   get('READ DATA', 'Latency Avg (ms)', 2),

        # Khusus Verify Hash
        'verify_berhasil':         get('VERIFIKASI HASH (INTEGRITAS)', 'Berhasil', 1),
        'verify_total':            get('VERIFIKASI HASH (INTEGRITAS)', 'Total Percobaan', 1),

        # Generic alias — dipakai untuk TX Success Rate gabungan (akademik saja, paling representatif)
        'tx_berhasil': get('STORE DATA AKADEMIK', 'Berhasil', 1),
        'tx_total':    get('STORE DATA AKADEMIK', 'Total Percobaan', 1),
    }

    if result['latency_baseline'] and result['latency_serangan']:
        result['latency_spike'] = result['latency_serangan'] / result['latency_baseline']
        # Persentase degradasi (bisa positif/naik atau negatif/turun)
        result['latency_degradasi_pct'] = (
            (result['latency_serangan'] - result['latency_baseline'])
            / result['latency_baseline'] * 100
        )
    else:
        result['latency_spike'] = None
        result['latency_degradasi_pct'] = None

    return result


def load_all_ddos(upload_dir):
    results = {}
    for platform in ['fabric', 'ethereum']:
        files = sorted(glob.glob(os.path.join(upload_dir, f'hasil_ddos_{platform}_*.xlsx')))
        iters = []
        for f in files:
            try:
                r = parse_ddos_file(f)
                r['_file'] = os.path.basename(f)
                iters.append(r)
                print(f"  ✓ {platform} — {os.path.basename(f)}: "
                      f"avail={r['availability']:.1f}% "
                      f"lat_base={r['latency_baseline']:.0f}ms "
                      f"lat_serangan={r['latency_serangan']:.0f}ms "
                      f"flood={r['flood_total']:.0f}")
            except Exception as e:
                print(f"  [!] {f}: {e}")
        results[platform] = iters
        print(f"  → Total {platform}: {len(iters)} iterasi\n")
    return results


def avg(lst, key):
    v = [r[key] for r in lst if r.get(key) is not None]
    return float(np.mean(v)) if v else 0.0

def std(lst, key):
    v = [r[key] for r in lst if r.get(key) is not None]
    return float(np.std(v)) if len(v) > 1 else 0.0

def rate_list(iters, berhasil_key, total_key):
    """List persentase success rate per iterasi (untuk avg/std konsisten)."""
    rates = []
    for r in iters:
        if r.get(total_key) and r[total_key] > 0:
            rates.append(r.get(berhasil_key, 0) / r[total_key] * 100)
    return rates

def watermark(fig):
    fig.text(0.99, 0.01, 'Tugas Akhir — Informatika UAJY',
             ha='right', va='bottom', fontsize=7, color=TEXT_MID, alpha=0.5)


# ══════════════════════════════════════════════════════════════
# GAMBAR A — Availability Saat Serangan DDoS
# Mengacu pada paragraf 1 Bab 5.3.3: kedua platform 100% availability
# di seluruh fase baseline, serangan, dan recovery.
# ══════════════════════════════════════════════════════════════
def plot_availability(ddos):
    fig, ax = plt.subplots(figsize=(9, 6.5))
    fig.subplots_adjust(top=0.85)
    fig.text(0.5, 0.96, 'Availability Sistem Selama Simulasi Serangan DDoS',
             ha='center', fontsize=14, fontweight='bold', color=TEXT_LIGHT)
    fig.text(0.5, 0.915, 'Health-Check Endpoint — Fase Baseline, Serangan, dan Recovery',
             ha='center', fontsize=9, color=TEXT_MID, style='italic')

    platforms = ['Fabric', 'Ethereum']
    avail_keys = ['avail_baseline', 'availability', 'avail_recovery']
    phase_labels = ['Baseline', 'Serangan', 'Recovery']
    phase_colors = [PASS_COLOR, WARN_COLOR, ETH_COLOR]
    x = np.arange(len(platforms))
    width = 0.25
    for i, (key, label, color) in enumerate(zip(avail_keys, phase_labels, phase_colors)):
        avgs2 = [avg(ddos['fabric'], key), avg(ddos['ethereum'], key)]
        bars = ax.bar(x + (i - 1) * width, avgs2, width,
                       color=color, edgecolor='#555555', lw=0.5, label=label, alpha=0.85)
        for bar, v in zip(bars, avgs2):
            ax.text(bar.get_x() + bar.get_width()/2, v + 0.3,
                     f'{v:.1f}%', ha='center', va='bottom', fontsize=9, color=TEXT_LIGHT, fontweight='bold')
    ax.set_xticks(x); ax.set_xticklabels(platforms, fontsize=11)
    ax.set_ylabel('Availability (%)'); ax.set_ylim(85, 116)
    ax.axhline(100, color=ACCENT_GOLD, lw=0.8, ls='--', alpha=0.4)
    ax.legend(fontsize=9, loc='upper center', ncol=3, bbox_to_anchor=(0.5, 1.0))

    # Anotasi total request health check (jumlah semua iterasi x semua fase)
    # Dipakai untuk klaim "X dari X health check berhasil" di teks pembahasan.
    count_keys = ['hc_total_baseline', 'hc_total_serangan', 'hc_total_recovery']
    ok_keys    = ['hc_ok_baseline', 'hc_ok_serangan', 'hc_ok_recovery']
    for i, platform in enumerate(['fabric', 'ethereum']):
        iters = ddos[platform]
        total_n  = sum(sum(r.get(k, 0) or 0 for k in count_keys) for r in iters)
        total_ok = sum(sum(r.get(k, 0) or 0 for k in ok_keys) for r in iters)
        ax.annotate(f'n = {int(total_ok)} / {int(total_n)} request berhasil ({len(iters)} iterasi)',
                    xy=(x[i], 86.3), ha='center', va='bottom',
                    fontsize=8, color=TEXT_MID, style='italic')

    watermark(fig)
    path = os.path.join(OUTPUT_DIR, 'grafik_10_ddos_availability.png')
    fig.savefig(path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    print(f"  ✓ {path}")
    return path


# ══════════════════════════════════════════════════════════════
# GAMBAR B — Latency Penyimpanan Data: Baseline → Serangan → Recovery
# Mengacu pada paragraf 3 & 6 Bab 5.3.3: perbandingan latency
# store data akademik di tiga fase, termasuk kemampuan recovery.
# ══════════════════════════════════════════════════════════════
def plot_latency_phases(ddos):
    fig, axes = plt.subplots(1, 2, figsize=(13, 6.5))
    fig.subplots_adjust(top=0.85, wspace=0.32)
    fig.text(0.5, 0.96, 'Latency Penyimpanan Data Akademik per Fase Pengujian',
             ha='center', fontsize=14, fontweight='bold', color=TEXT_LIGHT)
    fig.text(0.5, 0.915, 'Baseline → Saat Serangan HTTP Flood → Recovery',
             ha='center', fontsize=9, color=TEXT_MID, style='italic')

    phases     = ['Baseline', 'Serangan', 'Recovery']
    phase_keys = ['latency_baseline', 'latency_serangan', 'latency_recovery']

    for ax, platform, color in [(axes[0], 'fabric', FAB_COLOR),
                                 (axes[1], 'ethereum', ETH_COLOR)]:
        iters = ddos[platform]
        avgs = [avg(iters, k) for k in phase_keys]
        stds = [std(iters, k) for k in phase_keys]

        bars = ax.bar(phases, avgs, color=color, edgecolor='#555555', lw=0.6,
                      width=0.55, yerr=stds, capsize=6, alpha=0.88,
                      error_kw=dict(ecolor=ACCENT_GOLD, lw=1.5, capthick=2))
        for bar, v, s in zip(bars, avgs, stds):
            ax.text(bar.get_x() + bar.get_width()/2, v + s + max(avgs) * 0.03,
                    f'{v:,.0f} ms', ha='center', va='bottom', fontsize=10,
                    fontweight='bold', color=TEXT_LIGHT)

        ax.set_title(f'{platform.capitalize()} (n={len(iters)} iterasi)', fontsize=12, pad=12)
        ax.set_ylabel('Latency Rata-rata (ms)')
        ax.set_ylim(0, max(avgs) * 1.3 if avgs else 1)

    watermark(fig)
    path = os.path.join(OUTPUT_DIR, 'grafik_11_ddos_latency_penyimpanan.png')
    fig.savefig(path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    print(f"  ✓ {path}")
    return path


# ══════════════════════════════════════════════════════════════
# GAMBAR C — Degradasi Latency Saat Serangan (ms & %)
# Mengacu pada paragraf 5 Bab 5.3.3: kenaikan latency absolut (ms)
# dan persentase kenaikan saat serangan berlangsung.
# ══════════════════════════════════════════════════════════════
def plot_platform_comparison(ddos):
    fig, axes = plt.subplots(1, 2, figsize=(12, 6.5))
    fig.subplots_adjust(top=0.85, wspace=0.35)
    fig.text(0.5, 0.96, 'Degradasi Latency Penyimpanan Saat Serangan DDoS',
             ha='center', fontsize=14, fontweight='bold', color=TEXT_LIGHT)
    fig.text(0.5, 0.915, 'Kenaikan Latency Absolut (ms) dan Persentase Kenaikan (%)',
             ha='center', fontsize=9, color=TEXT_MID, style='italic')

    fab = ddos['fabric']
    eth = ddos['ethereum']
    platforms = ['Fabric', 'Ethereum']
    colors = [FAB_COLOR, ETH_COLOR]

    # Kiri — kenaikan latency absolut (ms) = serangan - baseline
    ax = axes[0]
    fab_delta = [r['latency_serangan'] - r['latency_baseline'] for r in fab
                 if r.get('latency_baseline') is not None and r.get('latency_serangan') is not None]
    eth_delta = [r['latency_serangan'] - r['latency_baseline'] for r in eth
                 if r.get('latency_baseline') is not None and r.get('latency_serangan') is not None]
    delta_avgs = [float(np.mean(fab_delta)) if fab_delta else 0,
                  float(np.mean(eth_delta)) if eth_delta else 0]
    delta_stds = [float(np.std(fab_delta)) if len(fab_delta) > 1 else 0,
                  float(np.std(eth_delta)) if len(eth_delta) > 1 else 0]
    bars = ax.bar(platforms, delta_avgs, color=colors, edgecolor='#555555', lw=0.6,
                  width=0.5, yerr=delta_stds, capsize=6, alpha=0.88,
                  error_kw=dict(ecolor=ACCENT_GOLD, lw=1.5, capthick=2))
    for bar, v, s in zip(bars, delta_avgs, delta_stds):
        ax.text(bar.get_x() + bar.get_width()/2, v + s + max(delta_avgs) * 0.04,
                f'+{v:,.0f} ms', ha='center', va='bottom', fontsize=10,
                fontweight='bold', color=TEXT_LIGHT)
    ax.set_ylabel('Kenaikan Latency (ms)')
    ax.set_title('Kenaikan Absolut (ms)', fontsize=11.5, pad=12)

    # Kanan — persentase kenaikan
    deg_avgs = [avg(fab, 'latency_degradasi_pct'), avg(eth, 'latency_degradasi_pct')]
    deg_stds = [std(fab, 'latency_degradasi_pct'), std(eth, 'latency_degradasi_pct')]
    ax2 = axes[1]
    bars2 = ax2.bar(platforms, deg_avgs, color=colors, edgecolor='#555555', lw=0.6,
                    width=0.5, yerr=deg_stds, capsize=6, alpha=0.88,
                    error_kw=dict(ecolor=ACCENT_GOLD, lw=1.5, capthick=2))
    for bar, v, s in zip(bars2, deg_avgs, deg_stds):
        ax2.text(bar.get_x() + bar.get_width()/2, v + s + 1.5,
                 f'+{v:.1f}%', ha='center', va='bottom', fontsize=10,
                 fontweight='bold', color=TEXT_LIGHT)
    ax2.axhline(0, color=ACCENT_GOLD, lw=1, ls='-', alpha=0.5)
    ax2.set_ylabel('Kenaikan Latency (%)')
    ax2.set_title('Kenaikan Persentase (%)', fontsize=11.5, pad=12)

    watermark(fig)
    path = os.path.join(OUTPUT_DIR, 'grafik_12_ddos_degradasi_latency.png')
    fig.savefig(path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    print(f"  ✓ {path}")
    return path


# ══════════════════════════════════════════════════════════════
# GAMBAR D — Latency Operasi Baca Data: Baseline vs Serangan
# Mengacu pada paragraf 7 Bab 5.3.3: latency baca data (read)
# yang melalui database backend, dibandingkan saat baseline & serangan.
# ══════════════════════════════════════════════════════════════
def plot_endpoint_latency(ddos):
    fig, ax = plt.subplots(figsize=(9, 6.5))
    fig.subplots_adjust(top=0.85)
    fig.text(0.5, 0.96, 'Latency Operasi Baca Data (Read) Saat Serangan DDoS',
             ha='center', fontsize=14, fontweight='bold', color=TEXT_LIGHT)
    fig.text(0.5, 0.915, 'Baseline vs Saat Serangan HTTP Flood',
             ha='center', fontsize=9, color=TEXT_MID, style='italic')

    fab = ddos['fabric']
    eth = ddos['ethereum']
    platforms = ['Fabric', 'Ethereum']
    read_keys = ['read_latency_baseline', 'read_latency_serangan']
    read_labels = ['Baseline', 'Serangan']
    read_colors = [PASS_COLOR, FAIL_COLOR]

    x = np.arange(len(platforms))
    width = 0.32
    for i, (key, label, color) in enumerate(zip(read_keys, read_labels, read_colors)):
        vals2 = [avg(fab, key), avg(eth, key)]
        stds2 = [std(fab, key), std(eth, key)]
        bars = ax.bar(x + (i - 0.5) * width, vals2, width, color=color,
                      edgecolor='#555555', lw=0.6, label=label, alpha=0.88,
                      yerr=stds2, capsize=5,
                      error_kw=dict(ecolor=ACCENT_GOLD, lw=1.3, capthick=1.5))
        for bar, v in zip(bars, vals2):
            ax.text(bar.get_x() + bar.get_width()/2, v + max(vals2) * 0.03,
                    f'{v:,.0f} ms', ha='center', va='bottom', fontsize=9.5,
                    fontweight='bold', color=TEXT_LIGHT)
    ax.set_xticks(x); ax.set_xticklabels(platforms, fontsize=11)
    ax.set_ylabel('Latency Rata-rata (ms)')
    ax.legend(fontsize=9)

    watermark(fig)
    path = os.path.join(OUTPUT_DIR, 'grafik_13_ddos_latency_read_data.png')
    fig.savefig(path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    print(f"  ✓ {path}")
    return path


# ══════════════════════════════════════════════════════════════
# GAMBAR E — Error Rate Request Saat Serangan DDoS
# Sumber: sheet "Ringkasan" > section "STATISTIK HTTP FLOOD" >
# baris "Flood Error Rate (%)" kolom "Saat HTTP Flood".
# Diverifikasi manual: error_rate = flood_gagal / flood_total x 100
# cocok persis dengan nilai yang tertulis di sheet (lihat cross-check).
# Ini BUKAN error rate transaksi sah (Store Akademik dsb, yang nyaris
# selalu 100% berhasil) — ini error rate trafik flood itu sendiri,
# yaitu seberapa banyak request serangan yang ditolak/timeout server.
# ══════════════════════════════════════════════════════════════
def plot_error_rate(ddos):
    fig, axes = plt.subplots(1, 2, figsize=(13, 6.5))
    fig.subplots_adjust(top=0.85, wspace=0.32)
    fig.text(0.5, 0.96, 'Error Rate Saat Serangan DDoS',
             ha='center', fontsize=14, fontweight='bold', color=TEXT_LIGHT)
    fig.text(0.5, 0.915, 'Flood Error Rate (%) dan Success Rate Transaksi Sah Saat Serangan',
             ha='center', fontsize=9, color=TEXT_MID, style='italic')

    fab = ddos['fabric']
    eth = ddos['ethereum']
    platforms = ['Fabric', 'Ethereum']
    colors = [FAB_COLOR, ETH_COLOR]

    # Kiri — Flood Error Rate (%): porsi request DDoS yang ditolak/timeout
    ax = axes[0]
    avgs = [avg(fab, 'flood_error_rate'), avg(eth, 'flood_error_rate')]
    stds = [std(fab, 'flood_error_rate'), std(eth, 'flood_error_rate')]
    bars = ax.bar(platforms, avgs, color=colors, edgecolor='#555555', lw=0.6,
                  width=0.5, yerr=stds, capsize=6, alpha=0.88,
                  error_kw=dict(ecolor=ACCENT_GOLD, lw=1.5, capthick=2))
    for bar, v, s in zip(bars, avgs, stds):
        ax.text(bar.get_x() + bar.get_width()/2, v + s + max(avgs) * 0.04,
                f'{v:.1f}%', ha='center', va='bottom', fontsize=10,
                fontweight='bold', color=TEXT_LIGHT)
    ax.set_ylabel('Flood Error Rate (%)')
    ax.set_title('Request Flood Ditolak/Timeout (%)', fontsize=11.5, pad=12)
    ax.set_ylim(0, max(avgs) * 1.4 if any(avgs) else 1)

    # Kanan — Success Rate transaksi sah (Store Akademik) saat serangan
    ax2 = axes[1]
    fab_rates = rate_list(fab, 'store_akademik_berhasil', 'store_akademik_total')
    eth_rates = rate_list(eth, 'store_akademik_berhasil', 'store_akademik_total')
    rate_avgs = [float(np.mean(fab_rates)) if fab_rates else 0,
                 float(np.mean(eth_rates)) if eth_rates else 0]
    rate_stds = [float(np.std(fab_rates)) if len(fab_rates) > 1 else 0,
                 float(np.std(eth_rates)) if len(eth_rates) > 1 else 0]
    bars2 = ax2.bar(platforms, rate_avgs, color=colors, edgecolor='#555555', lw=0.6,
                    width=0.5, yerr=rate_stds, capsize=6, alpha=0.88,
                    error_kw=dict(ecolor=ACCENT_GOLD, lw=1.5, capthick=2))
    for bar, v, s in zip(bars2, rate_avgs, rate_stds):
        ax2.text(bar.get_x() + bar.get_width()/2, v + s + 2,
                 f'{v:.1f}%', ha='center', va='bottom', fontsize=10,
                 fontweight='bold', color=TEXT_LIGHT)
    ax2.axhline(100, color=ACCENT_GOLD, lw=0.8, ls='--', alpha=0.4)
    ax2.set_ylabel('Success Rate (%)')
    ax2.set_ylim(0, 115)
    ax2.set_title('Transaksi Sah Berhasil Saat Serangan (%)', fontsize=11.5, pad=12)

    watermark(fig)
    path = os.path.join(OUTPUT_DIR, 'grafik_14_ddos_error_rate.png')
    fig.savefig(path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    print(f"  ✓ {path}")
    return path


# ══════════════════════════════════════════════════════════════
# GAMBAR F — Recovery Time (detik)
# !! SUMBER DATA: TIDAK ADA di file Excel hasil_ddos_*.xlsx !!
# Sheet "Ringkasan" hanya berisi snapshot 3 fase (Baseline/Saat
# Flood/Recovery), bukan durasi pemulihan dalam detik. Angka di
# bawah ini diisi MANUAL dari catatan waktu pengujian sendiri
# (RECOVERY_TIME_SECONDS di bagian atas file). Update angka itu
# langsung jika ada hasil pengukuran baru.
# ══════════════════════════════════════════════════════════════
def plot_recovery_time(ddos):
    fig, ax = plt.subplots(figsize=(8, 6.5))
    fig.subplots_adjust(top=0.83)
    fig.text(0.5, 0.95, 'Waktu Pemulihan (Recovery Time) Setelah Serangan DDoS',
             ha='center', fontsize=14, fontweight='bold', color=TEXT_LIGHT)
    fig.text(0.5, 0.90, 'Data dicatat manual saat pengujian — bukan dari file Excel',
             ha='center', fontsize=8.5, color=FAIL_COLOR, style='italic')

    platforms = ['Fabric', 'Ethereum']
    vals = [RECOVERY_TIME_SECONDS['fabric'], RECOVERY_TIME_SECONDS['ethereum']]
    colors = [FAB_COLOR, ETH_COLOR]
    bars = ax.bar(platforms, vals, color=colors, edgecolor='#555555', lw=0.6,
                  width=0.5, alpha=0.88)
    for bar, v in zip(bars, vals):
        ax.text(bar.get_x() + bar.get_width()/2, v + max(vals) * 0.03,
                f'{v:.1f} detik', ha='center', va='bottom', fontsize=11,
                fontweight='bold', color=TEXT_LIGHT)
    ax.set_ylabel('Waktu Pemulihan (detik)')
    ax.set_ylim(0, max(vals) * 1.25)

    watermark(fig)
    path = os.path.join(OUTPUT_DIR, 'grafik_15_ddos_recovery_time.png')
    fig.savefig(path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    print(f"  ✓ {path}")
    return path


# ══════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════
def main():
    print('\n' + '=' * 60)
    print('  ANALISIS DDOS — LOADER DIPERBAIKI')
    print(f'  {datetime.now().strftime("%d %B %Y, %H:%M")}')
    print('=' * 60)

    print('\n[1] Memuat data DDoS...')
    ddos = load_all_ddos(UPLOAD_DIR)

    print(f'\n  Ringkasan data yang terbaca:')
    for platform in ['fabric', 'ethereum']:
        iters = ddos[platform]
        if iters:
            print(f'  {platform.capitalize()}: {len(iters)} iterasi')
            print(f'    Avg latency baseline : {avg(iters, "latency_baseline"):,.1f} ms')
            print(f'    Avg latency serangan : {avg(iters, "latency_serangan"):,.1f} ms')
            print(f'    Avg latency recovery : {avg(iters, "latency_recovery"):,.1f} ms')
            print(f'    Avg flood total      : {avg(iters, "flood_total"):,.0f} requests')
            spikes = [r["latency_serangan"]/r["latency_baseline"]
                      for r in iters if r.get("latency_baseline") and r.get("latency_serangan")]
            if spikes:
                print(f'    Avg spike ratio      : ×{np.mean(spikes):.2f}')

    print('\n[2] Membuat grafik (mengikuti alur pembahasan Bab 5.3.3)...')
    saved = []

    print('  [Gambar A] Availability saat serangan DDoS...')
    saved.append(plot_availability(ddos))

    print('  [Gambar B] Latency penyimpanan: baseline-serangan-recovery...')
    saved.append(plot_latency_phases(ddos))

    print('  [Gambar C] Degradasi latency saat serangan (ms & %)...')
    saved.append(plot_platform_comparison(ddos))

    print('  [Gambar D] Latency operasi baca data (read)...')
    saved.append(plot_endpoint_latency(ddos))

    print('  [Gambar E] Error rate saat serangan DDoS...')
    saved.append(plot_error_rate(ddos))

    print('  [Gambar F] Recovery time (data manual)...')
    saved.append(plot_recovery_time(ddos))

    print('\n' + '=' * 60)
    print(f'  SELESAI — {len(saved)} grafik tersimpan di:')
    for p in saved:
        print(f'    {p}')
    print('=' * 60)

    return saved


if __name__ == '__main__':
    main()