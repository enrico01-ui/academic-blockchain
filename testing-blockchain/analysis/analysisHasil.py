"""
analisis_hasil_pengujian.py
===========================
Analisis & Visualisasi Grafik Hasil Pengujian Blockchain
Tugas Akhir — Perbandingan Ethereum Sepolia vs Hyperledger Fabric
Prodi Informatika UAJY

Cara pakai:
  pip install pandas matplotlib seaborn openpyxl numpy scipy
  python analisis_hasil_pengujian.py

Output folder ./hasil_grafik/:
  grafik_01_spam_latency_distribusi.png
  grafik_02_spam_perbandingan_metrik.png
  grafik_03_load_response_time.png
  grafik_04_load_throughput.png
  grafik_05_load_error_rate.png
  grafik_06_access_control_hasil.png
  grafik_07_access_control_latency.png
  grafik_08_integrity_summary.png
  grafik_09_integrity_per_doctype.png
  grafik_10_ddos_availability.png        ← BARU
  grafik_11_ddos_latency_perubahan.png   ← BARU
  grafik_12_ddos_perbandingan_platform.png ← BARU
  grafik_13_dashboard_keseluruhan.png
  laporan_grafik_pengujian.xlsx

Format file DDoS yang didukung (taruh di folder yang sama):
  hasil_ddos_fabric_*.xlsx   — sheet "Ringkasan" atau "Detail"
  hasil_ddos_ethereum_*.xlsx — sheet "Ringkasan" atau "Detail"
  Kolom yang dibaca: availability, latency_baseline, latency_serangan,
                     latency_pemulihan, tx_berhasil, tx_total, flood_total
"""

import os
import glob
import warnings
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.gridspec as gridspec
from openpyxl import Workbook, load_workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from datetime import datetime

warnings.filterwarnings('ignore')

# ══════════════════════════════════════════════════════════════
# KONFIGURASI ESTETIKA
# ══════════════════════════════════════════════════════════════
ETH_COLOR   = '#2E4BC6'
FAB_COLOR   = '#CC4400'
ETH_DARK    = '#1A2F8F'
FAB_DARK    = '#993300'
PASS_COLOR  = '#1A8A4A'
FAIL_COLOR  = '#B22222'
SKIP_COLOR  = '#607080'
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
    'legend.labelcolor':TEXT_LIGHT,
})

OUTPUT_DIR = './hasil_grafik'
os.makedirs(OUTPUT_DIR, exist_ok=True)


# ══════════════════════════════════════════════════════════════
# UTILITAS
# ══════════════════════════════════════════════════════════════

def save_fig(fig, filename, dpi=150):
    path = os.path.join(OUTPUT_DIR, filename)
    fig.savefig(path, dpi=dpi, bbox_inches='tight', facecolor=fig.get_facecolor())
    print(f"  ✓ Grafik disimpan: {filename}")
    return path

def add_title_banner(fig, title, subtitle=''):
    fig.text(0.5, 0.98, title, ha='center', va='top',
             fontsize=15, fontweight='bold', color=TEXT_LIGHT)
    if subtitle:
        fig.text(0.5, 0.955, subtitle, ha='center', va='top',
                 fontsize=9, color=TEXT_MID, style='italic')

def watermark(fig):
    fig.text(0.99, 0.01, 'Tugas Akhir — Informatika UAJY',
             ha='right', va='bottom', fontsize=7, color=TEXT_MID, alpha=0.5)

def styled_bar(ax, x, heights, color, width=0.35, label=''):
    bars = ax.bar(x, heights, width=width, color=color, label=label,
                  edgecolor='#555555', linewidth=0.5)
    for bar, h in zip(bars, heights):
        if h > 0:
            ax.text(bar.get_x() + bar.get_width()/2, h + max(heights)*0.02,
                    f'{h:,.1f}', ha='center', va='bottom',
                    fontsize=9, color=TEXT_LIGHT, fontweight='bold')
    return bars

def find_latest(pattern):
    files = glob.glob(pattern)
    return max(files, key=os.path.getmtime) if files else None

def find_all(pattern):
    files = glob.glob(pattern)
    return sorted(files, key=os.path.getmtime) if files else []


# ══════════════════════════════════════════════════════════════
# LOADER: SPAM TESTING
# ══════════════════════════════════════════════════════════════

def load_spam_data(platform, mode='sequential'):
    """Baca SEMUA iterasi hasil_spam_{platform}_{mode}_*.xlsx."""
    paths = find_all(f'hasil_spam_{platform}_{mode}_*.xlsx')
    if not paths:
        print(f"  [!] hasil_spam_{platform}_{mode}_*.xlsx tidak ditemukan — data dummy")
        return _dummy_spam(platform, mode)

    all_dfs, tps_list = [], []
    for path in paths:
        try:
            df = pd.read_excel(path, sheet_name='Detail Transaksi', skiprows=2, header=0)
            df.columns = [str(c).strip() for c in df.columns]
            df = df.iloc[:, :8]
            df.columns = ['no','student_id','status','http_code',
                          'latency_ms','tx_id','waktu','keterangan']
            df = df.dropna(subset=['no']).copy()
            df['latency_ms'] = pd.to_numeric(df['latency_ms'], errors='coerce')
            df['status']     = df['status'].astype(str).str.strip()
            all_dfs.append(df)

            # Coba baca TPS dari sheet Ringkasan
            try:
                rs = pd.read_excel(path, sheet_name='Ringkasan', header=None)
                for _, r in rs.iterrows():
                    k = str(r.iloc[0]).lower() if r.iloc[0] else ''
                    v = r.iloc[1] if len(r) > 1 else None
                    if ('throughput' in k or 'tps' in k) and v:
                        try:
                            tps_list.append(float(str(v).replace(',','.')))
                        except:
                            pass
            except:
                pass
        except Exception as e:
            print(f"  [!] {os.path.basename(path)}: {e}")

    if not all_dfs:
        return _dummy_spam(platform, mode)

    combined = pd.concat(all_dfs, ignore_index=True)
    combined._avg_tps   = float(np.mean(tps_list)) if tps_list else 0.0
    combined._n_iterasi = len(all_dfs)
    print(f"  ✓ spam {platform} {mode}: {len(all_dfs)} iterasi, "
          f"{len(combined)} transaksi, avg TPS={combined._avg_tps:.2f}")
    return combined

def _dummy_spam(platform, mode):
    np.random.seed(42 if platform == 'ethereum' else 99)
    n = 50 if platform == 'ethereum' else 500
    if mode == 'concurrent':
        n = int(n * 0.4)
    lats = (np.random.normal(3200, 800, n).clip(500, 8000)
            if platform == 'ethereum'
            else np.random.normal(180, 50, n).clip(30, 600))
    fail_p = 0.08 if platform == 'ethereum' else 0.02
    statuses = np.where(np.random.rand(n) < fail_p, 'Gagal', 'Berhasil')
    df = pd.DataFrame({'no': range(1, n+1),
        'student_id': [f'SPAM_{i:04d}' for i in range(1, n+1)],
        'status': statuses, 'latency_ms': lats, 'keterangan': ''})
    df._avg_tps   = 0.0
    df._n_iterasi = 0
    return df


# ══════════════════════════════════════════════════════════════
# LOADER: LOAD TESTING (JMeter)
# ══════════════════════════════════════════════════════════════

def load_load_test_summary():
    """
    Load hasil load testing dari semua iterasi hasil_load_testing_*.xlsx.
    Sheet 'Perbandingan' berisi kolom: ETH 10u, ETH 50u, ETH 100u, FAB 10u, FAB 50u, FAB 100u.
    Rata-ratakan semua iterasi secara benar (termasuk nilai 0).
    """
    from openpyxl import load_workbook as _lw
    platforms  = ['ethereum', 'fabric']
    users_list = [10, 50, 100]
    scenarios  = [(p, u) for p in platforms for u in users_list]

    files = find_all('hasil_load_testing_*.xlsx')
    if not files:
        print("  [!] File hasil_load_testing_*.xlsx tidak ditemukan — data dummy")
        return pd.DataFrame([_dummy_load(p, u) for p, u in scenarios])

    # Kumpulkan data per skenario dari semua file
    raw = {s: [] for s in scenarios}

    for fpath in files:
        try:
            wb = _lw(fpath, data_only=True)
            if 'Perbandingan' not in wb.sheetnames:
                continue
            ws = wb['Perbandingan']

            # Skip baris judul dan header, baca per metrik
            header_found = False
            metrics = {}
            for row in ws.iter_rows(values_only=True):
                if not row[0]:
                    continue
                label = str(row[0]).strip()
                if 'Metrik' in label or label.startswith('ETH'):
                    header_found = True
                    continue
                if header_found and label and not label.startswith('PERBANDINGAN'):
                    metrics[label.lower()] = list(row[1:7])

            for i, (platform, users) in enumerate(scenarios):
                d = {}
                for k, vals in metrics.items():
                    raw_val = vals[i] if i < len(vals) else None
                    if raw_val is None:
                        continue
                    # Konversi ke float — handle %, format 29 (93,5%), dll
                    try:
                        s = str(raw_val).replace('%', '').replace(',', '.').strip()
                        # Kalau ada tanda kurung (misal "29 (93,5%)"), ambil angka sebelum spasi
                        s = s.split('(')[0].strip()
                        num = float(s)
                    except:
                        continue

                    k_low = k.lower()
                    if 'error rate' in k_low:
                        d['error_pct'] = num          # SIMPAN meski 0.0
                    elif 'throughput' in k_low:
                        d['tps'] = num
                    elif 'latency rata' in k_low:
                        d['avg_ms'] = num
                    elif 'latency min' in k_low:
                        d['min_ms'] = num
                    elif 'latency maks' in k_low or 'latency max' in k_low:
                        d['max_ms'] = num
                    elif 'total request' in k_low:
                        d['total'] = num
                    elif 'request berhasil' in k_low:
                        d['ok'] = num
                if d:
                    raw[(platform, users)].append(d)

        except Exception as e:
            print(f"  [!] Gagal baca {os.path.basename(fpath)}: {e}")

    # Hitung rata-rata — INCLUDE nilai 0 (jangan skip dengan > 0)
    records = []
    for (platform, users), iters in raw.items():
        if not iters:
            records.append(_dummy_load(platform, users))
            continue

        def avg_field(key):
            # Ambil semua nilai termasuk 0, skip hanya None
            vals = [d[key] for d in iters if key in d]
            return float(np.mean(vals)) if vals else 0.0

        rec = dict(
            platform=platform, users=users,
            avg_ms=avg_field('avg_ms'), min_ms=avg_field('min_ms'),
            max_ms=avg_field('max_ms'), error_pct=avg_field('error_pct'),
            throughput=avg_field('tps'), samples=avg_field('total'),
        )
        records.append(rec)
        print(f"  ✓ {platform} {users}u: avg={rec['avg_ms']:.0f}ms "
              f"tps={rec['throughput']:.2f} err={rec['error_pct']:.1f}% "
              f"({len(iters)} iterasi)")

    return pd.DataFrame(records)

def _parse_jmeter_csv(path, platform, users):
    try:
        df = pd.read_csv(path)
        df.columns = [c.strip().lower().replace(' ','_') for c in df.columns]
        sub = df[~df.get('label','').str.lower().str.contains('total|setup|login', na=False)]
        if sub.empty:
            sub = df
        avg = pd.to_numeric(sub.get('average', 0), errors='coerce').mean()
        mn  = pd.to_numeric(sub.get('min', 0), errors='coerce').min()
        mx  = pd.to_numeric(sub.get('max', 0), errors='coerce').max()
        err_col = sub.get('error_%', sub.get('error_pct', pd.Series([0])))
        err = pd.to_numeric(str(err_col.iloc[0]).replace('%',''), errors='coerce')
        thr = pd.to_numeric(sub.get('throughput', 0), errors='coerce').mean()
        n   = pd.to_numeric(sub.get('#_samples', 0), errors='coerce').sum()
        return dict(platform=platform, users=users, avg_ms=avg, min_ms=mn,
                    max_ms=mx, error_pct=err, throughput=thr, samples=n)
    except Exception as e:
        print(f"  [!] CSV {path}: {e}")
        return _dummy_load(platform, users)

def _parse_load_excel(path, platform, users):
    try:
        df = pd.read_excel(path)
        df.columns = [str(c).strip().lower() for c in df.columns]
        avg = mn = mx = err = thr = n = 0
        for c in df.columns:
            vals = pd.to_numeric(df[c], errors='coerce')
            if any(k in c for k in ['average','avg','latency']): avg = vals.mean()
            elif 'min' in c: mn = vals.min()
            elif 'max' in c: mx = vals.max()
            elif 'error' in c: err = pd.to_numeric(str(df[c].iloc[0]).replace('%',''), errors='coerce')
            elif any(k in c for k in ['throughput','tps']): thr = vals.mean()
            elif any(k in c for k in ['sample','count']): n = vals.sum()
        return dict(platform=platform, users=users, avg_ms=avg, min_ms=mn,
                    max_ms=mx, error_pct=err, throughput=thr, samples=n)
    except Exception as e:
        print(f"  [!] Excel {path}: {e}")
        return _dummy_load(platform, users)

def _dummy_load(platform, users):
    np.random.seed(hash(platform + str(users)) % 1000)
    if platform == 'ethereum':
        base_avg = 3500 + users * 120
        base_thr = max(0.05, 0.8 - users * 0.007)
        base_err = min(30, users * 0.15)
    else:
        base_avg = 180 + users * 8
        base_thr = max(2, 15 - users * 0.05)
        base_err = min(5, users * 0.02)
    return dict(platform=platform, users=users,
                avg_ms=base_avg + np.random.normal(0, base_avg * 0.05),
                min_ms=base_avg * 0.3, max_ms=base_avg * 3.5,
                error_pct=base_err + np.random.normal(0, 0.5),
                throughput=base_thr + np.random.normal(0, base_thr * 0.1),
                samples=users * 3)


# ══════════════════════════════════════════════════════════════
# LOADER: ACCESS CONTROL
# ══════════════════════════════════════════════════════════════

def load_access_control_data():
    paths = find_all('hasil_access_control_*.xlsx')
    if not paths:
        print("  [!] hasil_access_control_*.xlsx tidak ditemukan — data dummy")
        return _dummy_access_control()

    all_dfs = []
    for path in paths:
        try:
            df = pd.read_excel(path, sheet_name='Detail Pengujian', skiprows=2, header=0)
            df.columns = [str(c).strip() for c in df.columns]
            cols = list(df.columns)
            if len(cols) >= 9:
                df = df.rename(columns={
                    cols[0]:'no', cols[1]:'kelompok', cols[2]:'layer',
                    cols[3]:'deskripsi', cols[4]:'endpoint', cols[5]:'expected',
                    cols[6]:'actual', cols[7]:'latency_ms', cols[8]:'status'})
            df = df.dropna(subset=['no']).copy()
            df['status']     = df['status'].astype(str).str.strip().str.upper()
            df['latency_ms'] = pd.to_numeric(df['latency_ms'], errors='coerce')
            df['_iterasi']   = os.path.basename(path)
            all_dfs.append(df)
        except Exception as e:
            print(f"  [!] {os.path.basename(path)}: {e}")

    if not all_dfs:
        return _dummy_access_control()

    combined = pd.concat(all_dfs, ignore_index=True)
    print(f"  ✓ access control: {len(all_dfs)} iterasi, {len(combined)} skenario")
    return combined

def _dummy_access_control():
    groups = {
        '1 — Tanpa Token':                             (9,  'API'),
        '2 — Token Palsu/Expired':                     (10, 'API'),
        '3 — Mahasiswa Akses Endpoint Admin/Dosen':    (15, 'API'),
        '4 — Dosen Akses Endpoint Admin':              (10, 'API'),
        '5 — Brute Force / Eskalasi Privilege':        (5,  'API'),
        '6 — Akses Langsung Smart Contract Ethereum':  (4,  'Smart Contract'),
        '7 — Akses Langsung Chaincode Fabric':         (4,  'Chaincode'),
    }
    rows = []; no = 1; np.random.seed(7)
    for grp, (total, layer) in groups.items():
        for i in range(total):
            rows.append({'no': no, 'kelompok': grp, 'layer': layer,
                'deskripsi': f'Skenario {i+1}',
                'latency_ms': np.random.uniform(30, 300),
                'status': 'LULUS'})
            no += 1
    return pd.DataFrame(rows)


# ══════════════════════════════════════════════════════════════
# LOADER: DOCUMENT INTEGRITY
# ══════════════════════════════════════════════════════════════

def load_integrity_data():
    path = find_latest('hasil_document_integrity_*.xlsx')
    results = {}
    if path:
        for platform, sheet in [('ethereum','Detail Ethereum'), ('fabric','Detail Fabric')]:
            try:
                df = pd.read_excel(path, sheet_name=sheet, skiprows=2, header=0)
                df.columns = [str(c).strip() for c in df.columns]
                df.columns = ['no','student_id','doc_type','file_name',
                              'file_hash','stored_hash','tx_id','latency_ms','status','error']
                df = df.dropna(subset=['no']).copy()
                df['latency_ms'] = pd.to_numeric(df['latency_ms'], errors='coerce')
                df['status']     = df['status'].astype(str).str.strip().str.upper()
                results[platform] = df
                print(f"  ✓ integrity {platform}: {len(df)} dokumen")
            except Exception as e:
                print(f"  [!] sheet {sheet}: {e}")
                results[platform] = _dummy_integrity(platform)
    else:
        print("  [!] hasil_document_integrity_*.xlsx tidak ditemukan — data dummy")
        results['ethereum'] = _dummy_integrity('ethereum')
        results['fabric']   = _dummy_integrity('fabric')
    return results

def _dummy_integrity(platform):
    np.random.seed(1 if platform == 'ethereum' else 2)
    n = 50
    lats = (np.random.normal(1800, 400, n).clip(200, 5000)
            if platform == 'ethereum'
            else np.random.normal(120, 30, n).clip(20, 500))
    statuses = np.where(np.random.rand(n) < 0.96, 'VALID', 'GAGAL')
    doc_types = np.random.choice(['transkrip','ijazah','krs','khs'], n)
    return pd.DataFrame({'no': range(1, n+1),
        'student_id': [f'MHSW{i:04d}' for i in range(1, n+1)],
        'doc_type': doc_types, 'latency_ms': lats,
        'status': statuses, 'error': ''})


# ══════════════════════════════════════════════════════════════
# LOADER: DDOS TESTING  ← fungsi loader yang diperbaiki & dilengkapi
# ══════════════════════════════════════════════════════════════

def load_ddos_data():
    """
    Baca SEMUA iterasi hasil DDoS dari:
      hasil_ddos_fabric_*.xlsx   (3 iterasi)
      hasil_ddos_ethereum_*.xlsx (3 iterasi)

    Kolom/baris yang dicari di sheet Ringkasan:
      availability, latency_baseline, latency_serangan,
      latency_pemulihan, tx_berhasil, tx_total, flood_total

    Jika file tidak ditemukan, gunakan data dummy yang realistis.
    Ganti nilai dummy dengan data nyata sesudah pengujian selesai.
    """
    results = {}
    for platform in ['fabric', 'ethereum']:
        paths = find_all(f'hasil_ddos_{platform}_*.xlsx')
        if not paths:
            print(f"  [!] hasil_ddos_{platform}_*.xlsx tidak ditemukan — data dummy")
            results[platform] = _dummy_ddos(platform)
            continue

        all_iter = []
        for path in paths:
            try:
                wb_ddos = load_workbook(path, data_only=True)
                # Cari sheet ringkasan
                sheet_names = [s for s in wb_ddos.sheetnames
                               if any(k in s.lower() for k in ['ringkasan','summary','hasil'])]
                if not sheet_names:
                    sheet_names = [wb_ddos.sheetnames[0]]

                ws = wb_ddos[sheet_names[0]]
                row_data = {}
                for row in ws.iter_rows():
                    cells = [c for c in row if c.value]
                    for idx, cell in enumerate(cells):
                        k = str(cell.value).strip().lower()
                        # Cari nilai di kolom kanan
                        next_val = cells[idx+1].value if idx+1 < len(cells) else None
                        if next_val is None:
                            continue
                        def to_f(v):
                            try:
                                return float(str(v).replace('%','').replace(',','.').strip())
                            except:
                                return None

                        if 'availability' in k or 'ketersediaan' in k:
                            row_data['availability'] = to_f(next_val)
                        if 'baseline' in k and ('latency' in k or 'ms' in k):
                            row_data['latency_baseline'] = to_f(next_val)
                        if ('serangan' in k or 'attack' in k) and ('latency' in k or 'ms' in k):
                            row_data['latency_serangan'] = to_f(next_val)
                        if ('pemulihan' in k or 'recovery' in k) and ('latency' in k or 'ms' in k):
                            row_data['latency_pemulihan'] = to_f(next_val)
                        if 'berhasil' in k and 'transaksi' in k:
                            row_data['tx_berhasil'] = to_f(next_val)
                        if ('total' in k or 'dikirim' in k) and 'transaksi' in k:
                            row_data['tx_total'] = to_f(next_val)
                        if 'flood' in k and ('total' in k or 'request' in k or 'paket' in k):
                            row_data['flood_total'] = to_f(next_val)
                        if 'waktu' in k and ('pulih' in k or 'recovery' in k):
                            row_data['recovery_time'] = to_f(next_val)

                if row_data:
                    all_iter.append(row_data)
                    print(f"  ✓ DDoS {platform} — {os.path.basename(path)}: {list(row_data.keys())}")
                else:
                    print(f"  [!] DDoS {platform} — {os.path.basename(path)}: tidak ada kolom yang dikenali")

            except Exception as e:
                print(f"  [!] DDoS {platform} {os.path.basename(path)}: {e}")

        results[platform] = all_iter if all_iter else _dummy_ddos(platform)

    return results

def _dummy_ddos(platform):
    """
    Data dummy DDoS yang realistis.
    3 iterasi per platform, setiap iterasi merekam 3 fase:
    baseline → serangan → pemulihan.
    """
    np.random.seed(10 if platform == 'fabric' else 20)
    iters = []
    for i in range(3):
        noise = np.random.uniform(0.95, 1.05)
        if platform == 'fabric':
            iters.append({
                'availability':     round(96.5 * noise, 2),   # %
                'latency_baseline': round(185  * noise, 1),   # ms — kondisi normal
                'latency_serangan': round(680  * noise, 1),   # ms — saat dibanjiri request
                'latency_pemulihan':round(210  * noise, 1),   # ms — setelah serangan berhenti
                'tx_berhasil':      int(14   * noise),        # transaksi sah yang berhasil
                'tx_total':         15,                        # transaksi sah yang dikirim
                'flood_total':      int(15000 * noise),       # jumlah request DDoS
                'recovery_time':    round(4.5 * noise, 1),   # detik untuk pulih
            })
        else:  # ethereum
            iters.append({
                'availability':     round(82.0 * noise, 2),
                'latency_baseline': round(13000 * noise, 1),
                'latency_serangan': round(19500 * noise, 1),
                'latency_pemulihan':round(14200 * noise, 1),
                'tx_berhasil':      int(3 * noise),
                'tx_total':         5,
                'flood_total':      int(15000 * noise),
                'recovery_time':    round(22.0 * noise, 1),
            })
    return iters


def _ddos_avg(ddos_list, key):
    """Rata-rata nilai key dari semua iterasi, skip None."""
    vals = [r.get(key) for r in ddos_list if r.get(key) is not None]
    return float(np.mean(vals)) if vals else 0.0

def _ddos_std(ddos_list, key):
    vals = [r.get(key) for r in ddos_list if r.get(key) is not None]
    return float(np.std(vals)) if len(vals) > 1 else 0.0


# ══════════════════════════════════════════════════════════════
# GRAFIK SPAM TESTING (1–2)
# ══════════════════════════════════════════════════════════════

def plot_spam_latency(df_eth_seq, df_eth_con, df_fab_seq, df_fab_con):
    fig, axes = plt.subplots(2, 2, figsize=(14, 9))
    fig.subplots_adjust(top=0.88, hspace=0.45, wspace=0.35)
    add_title_banner(fig,
        'Distribusi Latency — Spam Transaction Testing',
        'Sequential & Concurrent | Ethereum Sepolia vs Hyperledger Fabric')

    configs = [
        (axes[0,0], df_eth_seq, 'Ethereum — Sequential', ETH_COLOR),
        (axes[0,1], df_eth_con, 'Ethereum — Concurrent', ETH_DARK),
        (axes[1,0], df_fab_seq, 'Fabric — Sequential',   FAB_COLOR),
        (axes[1,1], df_fab_con, 'Fabric — Concurrent',   FAB_DARK),
    ]
    for ax, df, title, color in configs:
        lats = df['latency_ms'].dropna()
        if len(lats) == 0:
            ax.set_title(title); continue
        ax.hist(lats, bins=30, color=color, alpha=0.85, edgecolor='#555555', linewidth=0.4)
        avg = lats.mean(); p95 = lats.quantile(0.95)
        ax.axvline(avg, color=ACCENT_GOLD, linewidth=2, linestyle='--', label=f'Avg: {avg:,.0f}ms')
        ax.axvline(p95, color='#FF6B9D', linewidth=1.5, linestyle=':', label=f'P95: {p95:,.0f}ms')
        ax.set_title(title); ax.set_xlabel('Latency (ms)'); ax.set_ylabel('Frekuensi')
        ax.legend(fontsize=8)
        stats = f'n={len(lats)}\nMin: {lats.min():,.0f}ms\nMax: {lats.max():,.0f}ms\nStd: {lats.std():,.0f}ms'
        ax.text(0.97, 0.95, stats, transform=ax.transAxes, fontsize=7.5,
                va='top', ha='right', color=TEXT_MID,
                bbox=dict(boxstyle='round,pad=0.4', facecolor='#FFFFFF', alpha=0.8))
    watermark(fig)
    return save_fig(fig, 'grafik_01_spam_latency_distribusi.png')


def plot_spam_comparison(df_eth_seq, df_eth_con, df_fab_seq, df_fab_con):
    fig, axes = plt.subplots(1, 3, figsize=(15, 6))
    fig.subplots_adjust(top=0.84, wspace=0.38)
    add_title_banner(fig,
        'Ringkasan Metrik — Spam Transaction Testing',
        'Avg Latency | Throughput (TPS) | Success Rate')

    modes  = ['Seq\n(ETH)', 'Con\n(ETH)', 'Seq\n(FAB)', 'Con\n(FAB)']
    colors = [ETH_COLOR, ETH_DARK, FAB_COLOR, FAB_DARK]

    def compute(df):
        lats = df['latency_ms'].dropna()
        ok   = (df['status'].str.strip().str.lower() == 'berhasil').sum() if 'status' in df.columns else len(df)
        tps  = getattr(df, '_avg_tps', 0)
        if tps == 0 and len(lats) > 0:
            # fallback hitung dari data
            elapsed = lats.sum() / 1000
            tps = ok / elapsed if elapsed > 0 else 0
        rate = ok / len(df) * 100 if len(df) else 0
        return lats.mean() if len(lats) else 0, tps, rate

    data = [compute(df_eth_seq), compute(df_eth_con),
            compute(df_fab_seq), compute(df_fab_con)]
    avgs, tpss, rates = zip(*data)
    x = np.arange(4)

    for ax, vals, ylabel, fmt in [
        (axes[0], avgs,  'ms',                  lambda v: f'{v:,.0f}ms'),
        (axes[1], tpss,  'Transaksi/detik',      lambda v: f'{v:.2f}'),
        (axes[2], rates, '%',                    lambda v: f'{v:.1f}%'),
    ]:
        bars = ax.bar(x, vals, color=colors, edgecolor='#555555', linewidth=0.5, width=0.6)
        for bar, v in zip(bars, vals):
            ax.text(bar.get_x()+bar.get_width()/2, v + max(vals)*0.02,
                    fmt(v), ha='center', va='bottom', fontsize=9, color=TEXT_LIGHT)
        ax.set_xticks(x); ax.set_xticklabels(modes)
        ax.set_ylabel(ylabel)
    axes[0].set_title('Rata-rata Latency (ms)')
    axes[1].set_title('Throughput (TPS)')
    axes[2].set_title('Tingkat Keberhasilan (%)'); axes[2].set_ylim(0, 110)
    axes[2].axhline(100, color=ACCENT_GOLD, linewidth=0.8, linestyle='--', alpha=0.5)
    watermark(fig)
    return save_fig(fig, 'grafik_02_spam_perbandingan_metrik.png')


# ══════════════════════════════════════════════════════════════
# GRAFIK LOAD TESTING (3–5)
# ══════════════════════════════════════════════════════════════

def plot_load_response_time(df_load):
    fig, ax = plt.subplots(figsize=(11, 6))
    fig.subplots_adjust(top=0.86)
    add_title_banner(fig, 'Load Test — Response Time vs Jumlah User',
        'Pengaruh Concurrent User terhadap Latency')
    for platform, color, marker in [('ethereum', ETH_COLOR, 'o'), ('fabric', FAB_COLOR, 's')]:
        sub = df_load[df_load['platform'] == platform].sort_values('users')
        if sub.empty: continue
        ax.plot(sub['users'], sub['avg_ms'], color=color, marker=marker,
                linewidth=2.5, markersize=8, label=f'{platform.capitalize()} — Avg', zorder=3)
        ax.fill_between(sub['users'], sub['min_ms'], sub['max_ms'],
                        color=color, alpha=0.12)
        for _, row in sub.iterrows():
            ax.annotate(f"{row['avg_ms']:,.0f}ms", (row['users'], row['avg_ms']),
                        textcoords='offset points', xytext=(0, 12),
                        ha='center', fontsize=9, color=color, fontweight='bold')
    ax.set_xlabel('Jumlah Concurrent User'); ax.set_ylabel('Response Time (ms)')
    ax.set_title('Response Time per Jumlah User'); ax.set_xticks([10, 50, 100]); ax.legend()
    watermark(fig)
    return save_fig(fig, 'grafik_03_load_response_time.png')


def plot_load_throughput(df_load):
    fig, ax = plt.subplots(figsize=(11, 6))
    fig.subplots_adjust(top=0.86)
    add_title_banner(fig, 'Load Test — Throughput vs Jumlah User',
        'Kemampuan Sistem Melayani Request per Detik')
    x = np.arange(3); width = 0.35; users = [10, 50, 100]
    eth_thr = [df_load[(df_load['platform']=='ethereum')&(df_load['users']==u)]['throughput'].values[0]
               if not df_load[(df_load['platform']=='ethereum')&(df_load['users']==u)].empty else 0 for u in users]
    fab_thr = [df_load[(df_load['platform']=='fabric')&(df_load['users']==u)]['throughput'].values[0]
               if not df_load[(df_load['platform']=='fabric')&(df_load['users']==u)].empty else 0 for u in users]
    styled_bar(ax, x - width/2, eth_thr, ETH_COLOR, width, 'Ethereum Sepolia')
    styled_bar(ax, x + width/2, fab_thr, FAB_COLOR, width, 'Hyperledger Fabric')
    ax.set_xticks(x); ax.set_xticklabels(['10 Users','50 Users','100 Users'])
    ax.set_ylabel('Throughput (req/s)'); ax.set_title('Throughput per Konfigurasi User'); ax.legend()
    watermark(fig)
    return save_fig(fig, 'grafik_04_load_throughput.png')


def plot_load_error_rate(df_load):
    fig, axes = plt.subplots(1, 2, figsize=(13, 6))
    fig.subplots_adjust(top=0.85, wspace=0.35)
    add_title_banner(fig, 'Load Test — Error Rate & Perbandingan Keseluruhan',
        'Tingkat Error dan Skalabilitas Sistem')
    users = [10, 50, 100]; x = np.arange(3); width = 0.35

    eth_err = [df_load[(df_load['platform']=='ethereum')&(df_load['users']==u)]['error_pct'].values[0]
               if not df_load[(df_load['platform']=='ethereum')&(df_load['users']==u)].empty else 0 for u in users]
    fab_err = [df_load[(df_load['platform']=='fabric')&(df_load['users']==u)]['error_pct'].values[0]
               if not df_load[(df_load['platform']=='fabric')&(df_load['users']==u)].empty else 0 for u in users]

    styled_bar(axes[0], x-width/2, eth_err, ETH_COLOR, width, 'Ethereum')
    styled_bar(axes[0], x+width/2, fab_err, FAB_COLOR, width, 'Fabric')
    axes[0].set_xticks(x); axes[0].set_xticklabels(['10 Users','50 Users','100 Users'])
    axes[0].set_ylabel('Error Rate (%)'); axes[0].set_title('Tingkat Error per Konfigurasi')
    axes[0].legend()

    # Heatmap perbandingan metrik rata-rata
    eth_row = df_load[df_load['platform']=='ethereum']
    fab_row = df_load[df_load['platform']=='fabric']
    data = np.array([
        [eth_row['avg_ms'].mean(), eth_row['throughput'].mean(), eth_row['error_pct'].mean()],
        [fab_row['avg_ms'].mean(), fab_row['throughput'].mean(), fab_row['error_pct'].mean()],
    ])
    im = axes[1].imshow(data, cmap='RdYlGn_r', aspect='auto', vmin=0)
    axes[1].set_xticks(range(3))
    axes[1].set_xticklabels(['Avg Latency\n(ms)','Throughput\n(req/s)','Error Rate\n(%)'])
    axes[1].set_yticks(range(2)); axes[1].set_yticklabels(['Ethereum','Fabric'])
    axes[1].set_title('Perbandingan Metrik Rata-rata')
    for i in range(2):
        for j in range(3):
            axes[1].text(j, i, f'{data[i,j]:,.1f}', ha='center', va='center',
                         fontweight='bold', fontsize=10,
                         color='white' if im.norm(data[i,j]) < 0.3 or im.norm(data[i,j]) > 0.7 else 'black')
    watermark(fig)
    return save_fig(fig, 'grafik_05_load_error_rate.png')


# ══════════════════════════════════════════════════════════════
# GRAFIK ACCESS CONTROL (6–7)
# ══════════════════════════════════════════════════════════════

def plot_access_control(df_ac):
    fig = plt.figure(figsize=(15, 8))
    fig.subplots_adjust(top=0.87)
    add_title_banner(fig, 'Access Control Testing — Hasil per Kelompok Skenario',
        '7 Kelompok Skenario | Layer API & Blockchain')
    gs = gridspec.GridSpec(1, 2, figure=fig, width_ratios=[3, 1], wspace=0.3)
    ax_bar = fig.add_subplot(gs[0]); ax_pie = fig.add_subplot(gs[1])

    kelompoks = df_ac['kelompok'].unique()
    lulus_list, gagal_list, skip_list, short_labels = [], [], [], []
    for k in kelompoks:
        sub = df_ac[df_ac['kelompok'] == k]
        lulus_list.append((sub['status'] == 'LULUS').sum())
        gagal_list.append((sub['status'] == 'GAGAL').sum())
        skip_list.append((sub['status'] == 'SKIP').sum())
        label = str(k)
        if '—' in label:
            label = 'K' + label.split('—')[0].strip().replace(' ','')
        short_labels.append(label[:18])

    x = np.arange(len(kelompoks)); width = 0.6
    ax_bar.bar(x, lulus_list, width, label='Lulus',  color=PASS_COLOR, edgecolor='#555555', lw=0.5)
    ax_bar.bar(x, gagal_list, width, bottom=lulus_list, label='Gagal', color=FAIL_COLOR, edgecolor='#555555', lw=0.5)
    bottom3 = [l+g for l,g in zip(lulus_list, gagal_list)]
    ax_bar.bar(x, skip_list, width, bottom=bottom3, label='Skip', color=SKIP_COLOR, edgecolor='#555555', lw=0.5, alpha=0.7)
    for i, (l, g, s) in enumerate(zip(lulus_list, gagal_list, skip_list)):
        total = l+g+s
        if total > 0:
            ax_bar.text(i, total+0.15, f'{l}/{total}', ha='center', va='bottom',
                        fontsize=8.5, color=TEXT_LIGHT, fontweight='bold')
    ax_bar.set_xticks(x); ax_bar.set_xticklabels(short_labels, rotation=20, ha='right', fontsize=9)
    ax_bar.set_ylabel('Jumlah Skenario'); ax_bar.set_title('Hasil per Kelompok Uji'); ax_bar.legend()

    total_l, total_g, total_s = sum(lulus_list), sum(gagal_list), sum(skip_list)
    sizes  = [v for v in [total_l, total_g, total_s] if v > 0]
    labels = [l for l, v in zip([f'Lulus ({total_l})',f'Gagal ({total_g})',f'Skip ({total_s})'],
                                 [total_l, total_g, total_s]) if v > 0]
    colors = [c for c, v in zip([PASS_COLOR, FAIL_COLOR, SKIP_COLOR],
                                  [total_l, total_g, total_s]) if v > 0]
    if sizes:
        _, _, autotexts = ax_pie.pie(sizes, labels=labels, colors=colors, autopct='%1.1f%%',
            startangle=90, wedgeprops=dict(edgecolor='#FFFFFF', linewidth=1.5),
            textprops=dict(color=TEXT_LIGHT, fontsize=9))
        for at in autotexts:
            at.set_color('#1A1A2E'); at.set_fontweight('bold')
    ax_pie.set_title(f'Total: {total_l+total_g+total_s} Skenario')
    watermark(fig)
    return save_fig(fig, 'grafik_06_access_control_hasil.png')


def plot_access_control_latency(df_ac):
    fig, axes = plt.subplots(1, 2, figsize=(13, 6))
    fig.subplots_adjust(top=0.85, wspace=0.35)
    add_title_banner(fig, 'Access Control — Distribusi Latency per Layer',
        'API Layer vs Blockchain Layer')

    layers = df_ac['layer'].dropna().unique()
    colors_map = {'API': ETH_COLOR, 'Smart Contract': FAB_COLOR,
                  'Chaincode': FAB_DARK, 'Blockchain': FAB_COLOR}
    data_by_layer = [df_ac[df_ac['layer']==l]['latency_ms'].dropna().values for l in layers]
    bp = axes[0].boxplot(data_by_layer, labels=layers, patch_artist=True,
                         medianprops=dict(color=ACCENT_GOLD, linewidth=2))
    for patch, l in zip(bp['boxes'], layers):
        patch.set_facecolor(colors_map.get(l, ETH_COLOR)); patch.set_alpha(0.85)
    axes[0].set_ylabel('Latency (ms)'); axes[0].set_title('Distribusi Latency per Layer')

    grp_lat = df_ac.groupby('kelompok')['latency_ms'].mean().dropna()
    short = [str(k).split('—')[0].strip()[:15] for k in grp_lat.index]
    xs = np.arange(len(grp_lat))
    grp_colors = [FAB_COLOR if any(t in str(k) for t in ['Smart Contract','Chaincode','6','7'])
                  else ETH_COLOR for k in grp_lat.index]
    axes[1].bar(xs, grp_lat.values, color=grp_colors, edgecolor='#555555', lw=0.5, width=0.65)
    axes[1].set_xticks(xs); axes[1].set_xticklabels(short, rotation=25, ha='right', fontsize=8)
    axes[1].set_ylabel('Avg Latency (ms)'); axes[1].set_title('Rata-rata Latency per Kelompok')
    axes[1].legend(handles=[mpatches.Patch(color=ETH_COLOR, label='API Layer'),
                             mpatches.Patch(color=FAB_COLOR, label='Blockchain Layer')])
    watermark(fig)
    return save_fig(fig, 'grafik_07_access_control_latency.png')


# ══════════════════════════════════════════════════════════════
# GRAFIK DOCUMENT INTEGRITY (8–9)
# ══════════════════════════════════════════════════════════════

def plot_integrity_summary(df_eth_int, df_fab_int):
    fig, axes = plt.subplots(1, 3, figsize=(15, 6))
    fig.subplots_adjust(top=0.85, wspace=0.38)
    add_title_banner(fig, 'Document Integrity Testing — Verifikasi Hash Blockchain',
        'File Hash (DB) vs Hash Blockchain')

    for idx, (platform, df, color) in enumerate([
            ('Ethereum', df_eth_int, ETH_COLOR),
            ('Fabric',   df_fab_int, FAB_COLOR)]):
        ax = axes[idx]
        valid = (df['status'].str.upper() == 'VALID').sum()
        gagal = (df['status'].str.upper() == 'GAGAL').sum()
        sizes  = [v for v in [valid, gagal] if v > 0]
        labels = [l for l, v in zip([f'Valid ({valid})',f'Gagal ({gagal})'], [valid, gagal]) if v > 0]
        colors = [PASS_COLOR if 'Valid' in l else FAIL_COLOR for l in labels]
        if sizes:
            _, _, autotexts = ax.pie(sizes, labels=labels, colors=colors, autopct='%1.1f%%',
                startangle=90, wedgeprops=dict(edgecolor='#FFFFFF', linewidth=1.5),
                textprops=dict(color=TEXT_LIGHT, fontsize=10))
            for at in autotexts:
                at.set_color('#1A1A2E'); at.set_fontweight('bold')
        ax.set_title(f'{platform}\n({len(df)} Dokumen)')

    eth_lats = df_eth_int['latency_ms'].dropna().values
    fab_lats = df_fab_int['latency_ms'].dropna().values
    data = [d for d in [eth_lats, fab_lats] if len(d) > 0]
    if data:
        bp = axes[2].boxplot(data, labels=['Ethereum','Fabric'][:len(data)],
                             patch_artist=True, medianprops=dict(color=ACCENT_GOLD, linewidth=2))
        for patch, c in zip(bp['boxes'], [ETH_COLOR, FAB_COLOR]):
            patch.set_facecolor(c); patch.set_alpha(0.85)
        axes[2].set_ylabel('Latency (ms)'); axes[2].set_title('Distribusi Latency Verifikasi')
        for i, lats in enumerate([eth_lats, fab_lats]):
            if len(lats):
                axes[2].text(i+1, np.mean(lats), f' {np.mean(lats):,.0f}ms',
                             va='center', fontsize=9, color=ACCENT_GOLD)
    watermark(fig)
    return save_fig(fig, 'grafik_08_integrity_summary.png')


def plot_integrity_detail(df_eth_int, df_fab_int):
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    fig.subplots_adjust(top=0.85, wspace=0.38)
    add_title_banner(fig, 'Document Integrity — Valid Rate per Tipe Dokumen', '')

    for ax, (platform, df, color) in zip(axes, [
            ('Ethereum', df_eth_int, ETH_COLOR),
            ('Fabric',   df_fab_int, FAB_COLOR)]):
        if 'doc_type' not in df.columns:
            ax.set_title(platform); continue
        grp = df.groupby('doc_type')['status'].apply(
            lambda s: (s.str.upper() == 'VALID').sum() / len(s) * 100
        ).sort_values(ascending=True)
        if grp.empty:
            ax.set_title(platform); continue
        y = np.arange(len(grp))
        ax.barh(y, grp.values, color=color, edgecolor='#555555', lw=0.5, alpha=0.85)
        for yi, v in zip(y, grp.values):
            ax.text(v+0.5, yi, f'{v:.1f}%', va='center', fontsize=9, color=TEXT_LIGHT)
        ax.set_yticks(y); ax.set_yticklabels(grp.index, fontsize=9)
        ax.set_xlabel('Valid Rate (%)'); ax.set_title(f'{platform} — Valid Rate per Tipe')
        ax.set_xlim(0, 110); ax.axvline(100, color=ACCENT_GOLD, lw=0.8, ls='--', alpha=0.5)
    watermark(fig)
    return save_fig(fig, 'grafik_09_integrity_per_doctype.png')


# ══════════════════════════════════════════════════════════════
# GRAFIK DDOS TESTING (10–12)  ← BARU & LENGKAP
# ══════════════════════════════════════════════════════════════

def plot_ddos_availability(ddos_data):
    """
    Grafik 10 — Availability (%) per iterasi + rata-rata,
    dibandingkan antara Fabric dan Ethereum.
    """
    fig, axes = plt.subplots(1, 2, figsize=(14, 7))
    fig.subplots_adjust(top=0.87, wspace=0.38)
    add_title_banner(fig,
        'DDoS Resilience — System Availability (%)',
        'Persentase Ketersediaan Sistem Saat & Setelah Serangan DDoS')

    # Kiri: scatter per iterasi + garis rata-rata
    ax = axes[0]
    for platform, color, marker in [('fabric','#FF6B35','o'), ('ethereum','#627EEA','s')]:
        iters = ddos_data.get(platform, [])
        vals  = [r.get('availability', 0) for r in iters if r.get('availability') is not None]
        xs    = np.arange(1, len(vals)+1)
        if vals:
            ax.plot(xs, vals, color=color, marker=marker, linewidth=2, markersize=9,
                    label=f'{platform.capitalize()}', zorder=3)
            ax.fill_between(xs, vals, alpha=0.10, color=color)
            avg = np.mean(vals)
            ax.axhline(avg, color=color, linewidth=1.2, linestyle='--', alpha=0.7,
                       label=f'Avg {platform.capitalize()}: {avg:.1f}%')
            # Anotasi tiap titik
            for xi, v in zip(xs, vals):
                ax.annotate(f'{v:.1f}%', (xi, v),
                            textcoords='offset points', xytext=(0, 10),
                            ha='center', fontsize=8.5, color=color, fontweight='bold')

    ax.set_xlabel('Iterasi Ke-'); ax.set_ylabel('Availability (%)')
    ax.set_title('Availability per Iterasi')
    ax.set_xticks(range(1, max(len(ddos_data.get('fabric',[])),
                                len(ddos_data.get('ethereum',[]))) + 1))
    ax.set_ylim(60, 105)
    ax.axhline(100, color=ACCENT_GOLD, linewidth=0.8, linestyle=':', alpha=0.5)
    ax.legend(fontsize=9)

    # Kanan: bar rata-rata dengan error bar (std dev)
    ax2 = axes[1]
    platforms  = ['Fabric', 'Ethereum']
    avgs       = [_ddos_avg(ddos_data.get('fabric',[]), 'availability'),
                  _ddos_avg(ddos_data.get('ethereum',[]), 'availability')]
    stds       = [_ddos_std(ddos_data.get('fabric',[]), 'availability'),
                  _ddos_std(ddos_data.get('ethereum',[]), 'availability')]
    colors_bar = [FAB_COLOR, ETH_COLOR]
    bars = ax2.bar(platforms, avgs, color=colors_bar, edgecolor='#555555', lw=0.5,
                   width=0.5, yerr=stds, capsize=6,
                   error_kw=dict(ecolor=ACCENT_GOLD, lw=2, capthick=2))
    for bar, v, s in zip(bars, avgs, stds):
        ax2.text(bar.get_x()+bar.get_width()/2, v + s + 1,
                 f'{v:.1f}%\n±{s:.1f}', ha='center', va='bottom',
                 fontsize=10, fontweight='bold', color=TEXT_LIGHT)
    ax2.set_ylabel('Availability (%)'); ax2.set_title('Rata-rata Availability (±Std Dev)')
    ax2.set_ylim(60, 115)
    ax2.axhline(100, color=ACCENT_GOLD, linewidth=0.8, linestyle='--', alpha=0.5, label='100%')
    ax2.legend(fontsize=9)

    watermark(fig)
    return save_fig(fig, 'grafik_10_ddos_availability.png')


def plot_ddos_latency_phases(ddos_data):
    """
    Grafik 11 — Perubahan latency antar fase:
    Baseline → Serangan → Pemulihan
    untuk setiap platform, ditampilkan per iterasi + rata-rata.
    """
    fig, axes = plt.subplots(1, 2, figsize=(14, 7))
    fig.subplots_adjust(top=0.87, wspace=0.42)
    add_title_banner(fig,
        'DDoS Resilience — Perubahan Latency per Fase',
        'Baseline → Fase Serangan → Fase Pemulihan')

    phases      = ['Baseline', 'Serangan', 'Pemulihan']
    phase_keys  = ['latency_baseline', 'latency_serangan', 'latency_pemulihan']
    phase_colors = [PASS_COLOR, FAIL_COLOR, WARN_COLOR]
    x = np.arange(len(phases)); width = 0.25

    for ax, platform, color in [(axes[0], 'fabric', FAB_COLOR),
                                  (axes[1], 'ethereum', ETH_COLOR)]:
        iters = ddos_data.get(platform, [])

        # Garis per iterasi (tipis, transparan)
        for idx, run in enumerate(iters):
            vals_run = [run.get(k, 0) or 0 for k in phase_keys]
            ax.plot(phases, vals_run, color=color, linewidth=1.2,
                    alpha=0.35, marker='o', markersize=5,
                    label=f'Iterasi {idx+1}' if idx == 0 else '_nolegend_')

        # Rata-rata tebal
        avgs = [_ddos_avg(iters, k) for k in phase_keys]
        stds = [_ddos_std(iters, k) for k in phase_keys]
        ax.plot(phases, avgs, color=color, linewidth=3, marker='D', markersize=9,
                label='Rata-rata', zorder=5)
        ax.fill_between(phases,
                        [a-s for a,s in zip(avgs,stds)],
                        [a+s for a,s in zip(avgs,stds)],
                        color=color, alpha=0.15)

        # Anotasi nilai rata-rata
        for i, (v, s) in enumerate(zip(avgs, stds)):
            ax.annotate(f'{v:,.0f}ms\n±{s:,.0f}',
                        xy=(i, v), textcoords='offset points',
                        xytext=(0, 14), ha='center', fontsize=8.5,
                        color=ACCENT_GOLD, fontweight='bold')

        # Arsir area serangan
        ax.axvspan(0.5, 1.5, alpha=0.07, color=FAIL_COLOR)
        ax.text(1, ax.get_ylim()[0] if ax.get_ylim()[0] > 0 else avgs[0]*0.05,
                'SERANGAN', ha='center', va='bottom',
                fontsize=7.5, color=FAIL_COLOR, alpha=0.6)

        ax.set_title(f'{platform.capitalize()} — Latency per Fase')
        ax.set_ylabel('Latency (ms)')
        ax.legend(fontsize=8)

    watermark(fig)
    return save_fig(fig, 'grafik_11_ddos_latency_perubahan.png')


def plot_ddos_platform_comparison(ddos_data):
    """
    Grafik 12 — Perbandingan Fabric vs Ethereum:
    4 panel: Availability | Latency Baseline | Latency Serangan |
             Recovery Time | TX Success Rate | Flood Total
    """
    fig, axes = plt.subplots(2, 3, figsize=(16, 10))
    fig.subplots_adjust(top=0.88, hspace=0.45, wspace=0.38)
    add_title_banner(fig,
        'DDoS Resilience — Perbandingan Lengkap Fabric vs Ethereum',
        'Availability | Latency Fase | Recovery Time | Transaction Success | Flood Volume')

    fab_iters = ddos_data.get('fabric',   [])
    eth_iters = ddos_data.get('ethereum', [])
    platforms = ['Fabric', 'Ethereum']
    colors    = [FAB_COLOR, ETH_COLOR]

    def bar2(ax, key, ylabel, title, fmt='ms', multiplier=1):
        """Bar chart 2 platform dengan error bar."""
        avgs = [_ddos_avg(fab_iters, key) * multiplier,
                _ddos_avg(eth_iters, key) * multiplier]
        stds = [_ddos_std(fab_iters, key) * multiplier,
                _ddos_std(eth_iters, key) * multiplier]
        bars = ax.bar(platforms, avgs, color=colors, edgecolor='#555555', lw=0.5,
                      width=0.5, yerr=stds, capsize=6,
                      error_kw=dict(ecolor=ACCENT_GOLD, lw=1.5, capthick=2))
        for bar, v, s in zip(bars, avgs, stds):
            label_v = f'{v:,.1f}{fmt}\n±{s:,.1f}' if s > 0 else f'{v:,.1f}{fmt}'
            ax.text(bar.get_x()+bar.get_width()/2, v+s+max(avgs)*0.04,
                    label_v, ha='center', va='bottom', fontsize=9,
                    fontweight='bold', color=TEXT_LIGHT)
        ax.set_ylabel(ylabel); ax.set_title(title)

    # Row 0
    bar2(axes[0,0], 'availability',      '%',  'Availability (%)',       fmt='%')
    bar2(axes[0,1], 'latency_baseline',  'ms', 'Latency Baseline (ms)',  fmt='ms')
    bar2(axes[0,2], 'latency_serangan',  'ms', 'Latency Saat Serangan',  fmt='ms')

    # Row 1
    bar2(axes[1,0], 'recovery_time',     'dtk','Recovery Time (detik)',  fmt='s')
    bar2(axes[1,1], 'flood_total',       'req','Total Request DDoS',     fmt='')

    # Panel terakhir: TX success rate per platform
    ax = axes[1,2]
    fab_rate = _ddos_avg(fab_iters, 'tx_berhasil') / max(_ddos_avg(fab_iters, 'tx_total'), 1) * 100
    eth_rate = _ddos_avg(eth_iters, 'tx_berhasil') / max(_ddos_avg(eth_iters, 'tx_total'), 1) * 100
    fab_std_r = _ddos_std(fab_iters, 'tx_berhasil') / max(_ddos_avg(fab_iters, 'tx_total'), 1) * 100
    eth_std_r = _ddos_std(eth_iters, 'tx_berhasil') / max(_ddos_avg(eth_iters, 'tx_total'), 1) * 100
    avgs = [fab_rate, eth_rate]; stds = [fab_std_r, eth_std_r]
    bars = ax.bar(platforms, avgs, color=colors, edgecolor='#555555', lw=0.5,
                  width=0.5, yerr=stds, capsize=6,
                  error_kw=dict(ecolor=ACCENT_GOLD, lw=1.5, capthick=2))
    for bar, v, s in zip(bars, avgs, stds):
        ax.text(bar.get_x()+bar.get_width()/2, v+s+2,
                f'{v:.1f}%', ha='center', va='bottom',
                fontsize=10, fontweight='bold', color=TEXT_LIGHT)
    ax.set_ylabel('%'); ax.set_title('TX Success Rate Saat Serangan'); ax.set_ylim(0, 115)
    ax.axhline(100, color=ACCENT_GOLD, lw=0.8, ls='--', alpha=0.4)

    watermark(fig)
    return save_fig(fig, 'grafik_12_ddos_perbandingan_platform.png')


# ══════════════════════════════════════════════════════════════
# GRAFIK DASHBOARD KESELURUHAN (13)
# ══════════════════════════════════════════════════════════════

def plot_dashboard_summary(df_eth_seq, df_fab_seq, df_load,
                           df_ac, df_eth_int, df_fab_int, ddos_data):
    fig = plt.figure(figsize=(20, 13))
    fig.subplots_adjust(top=0.91, bottom=0.06, hspace=0.55,
                        wspace=0.42, left=0.06, right=0.97)
    add_title_banner(fig,
        'DASHBOARD HASIL PENGUJIAN — ETHEREUM SEPOLIA vs HYPERLEDGER FABRIC',
        'Spam | Load Test | Access Control | Document Integrity | DDoS Resilience')
    fig.text(0.5, 0.94, f'Dibuat: {datetime.now().strftime("%d %B %Y, %H:%M")}',
             ha='center', fontsize=9, color=TEXT_MID)

    gs = gridspec.GridSpec(3, 5, figure=fig)

    # ── Row 0: Spam latency | Load throughput | DDoS availability ──
    ax1 = fig.add_subplot(gs[0, :2])
    vals_spam = [df_eth_seq['latency_ms'].mean(), df_fab_seq['latency_ms'].mean()]
    bars = ax1.bar(['Ethereum','Fabric'], vals_spam,
                   color=[ETH_COLOR, FAB_COLOR], edgecolor='#555555', lw=0.5, width=0.5)
    for bar, v in zip(bars, vals_spam):
        ax1.text(bar.get_x()+bar.get_width()/2, v+max(vals_spam)*0.03,
                 f'{v:,.0f}ms', ha='center', va='bottom',
                 fontsize=10, fontweight='bold', color=TEXT_LIGHT)
    ax1.set_title('Spam Test — Avg Latency (Sequential)'); ax1.set_ylabel('ms')

    ax2 = fig.add_subplot(gs[0, 2:4])
    eth_thr = df_load[df_load['platform']=='ethereum']['throughput'].values
    fab_thr = df_load[df_load['platform']=='fabric']['throughput'].values
    if len(eth_thr) >= 3 and len(fab_thr) >= 3:
        ax2.plot([10,50,100], eth_thr[:3], 'o-', color=ETH_COLOR, lw=2.5, ms=8, label='Ethereum')
        ax2.plot([10,50,100], fab_thr[:3], 's-', color=FAB_COLOR, lw=2.5, ms=8, label='Fabric')
        ax2.fill_between([10,50,100], eth_thr[:3], alpha=0.12, color=ETH_COLOR)
        ax2.fill_between([10,50,100], fab_thr[:3], alpha=0.12, color=FAB_COLOR)
    ax2.set_xlabel('Users'); ax2.set_ylabel('req/s')
    ax2.set_title('Load Test — Throughput'); ax2.set_xticks([10,50,100]); ax2.legend(fontsize=8)

    ax3 = fig.add_subplot(gs[0, 4])
    avail_fab = _ddos_avg(ddos_data.get('fabric',[]),   'availability')
    avail_eth = _ddos_avg(ddos_data.get('ethereum',[]), 'availability')
    ax3.bar(['Fabric','Ethereum'], [avail_fab, avail_eth],
            color=[FAB_COLOR, ETH_COLOR], edgecolor='#555555', lw=0.5, width=0.55)
    for i, (v, p) in enumerate(zip([avail_fab, avail_eth], ['Fabric','Ethereum'])):
        ax3.text(i, v+1, f'{v:.1f}%', ha='center', va='bottom',
                 fontsize=10, fontweight='bold', color=TEXT_LIGHT)
    ax3.set_ylabel('%'); ax3.set_title('DDoS — Availability'); ax3.set_ylim(60, 115)

    # ── Row 1: Access Control | Integrity | DDoS latency phases ──
    ax4 = fig.add_subplot(gs[1, :2])
    lulus = (df_ac['status'] == 'LULUS').sum()
    gagal = (df_ac['status'] == 'GAGAL').sum()
    skip  = (df_ac['status'] == 'SKIP').sum()
    total_ac = lulus + gagal + skip
    sizes = [v for v in [lulus, gagal, skip] if v > 0]
    lbls  = [l for l, v in zip([f'Lulus\n{lulus}',f'Gagal\n{gagal}',f'Skip\n{skip}'],
                                 [lulus, gagal, skip]) if v > 0]
    clrs  = [c for c, v in zip([PASS_COLOR, FAIL_COLOR, SKIP_COLOR], [lulus, gagal, skip]) if v > 0]
    if sizes:
        _, _, autotexts = ax4.pie(sizes, labels=lbls, colors=clrs, autopct='%1.1f%%',
            startangle=90, wedgeprops=dict(edgecolor='#FFFFFF', lw=1.5),
            textprops=dict(color=TEXT_LIGHT, fontsize=9))
        for at in autotexts:
            at.set_color('#1A1A2E'); at.set_fontweight('bold')
    ax4.set_title(f'Access Control ({total_ac} Skenario)')

    ax5 = fig.add_subplot(gs[1, 2:4])
    eth_ok = (df_eth_int['status'].str.upper()=='VALID').sum()
    fab_ok = (df_fab_int['status'].str.upper()=='VALID').sum()
    eth_f  = (df_eth_int['status'].str.upper()=='GAGAL').sum()
    fab_f  = (df_fab_int['status'].str.upper()=='GAGAL').sum()
    x = np.arange(2); w = 0.35
    ax5.bar(x-w/2, [eth_ok, fab_ok], w, color=PASS_COLOR, label='Valid', edgecolor='#555555', lw=0.5)
    ax5.bar(x+w/2, [eth_f,  fab_f],  w, color=FAIL_COLOR, label='Gagal', edgecolor='#555555', lw=0.5)
    ax5.set_xticks(x); ax5.set_xticklabels(['Ethereum','Fabric'])
    ax5.set_ylabel('Dokumen'); ax5.set_title('Document Integrity'); ax5.legend(fontsize=8)

    ax6 = fig.add_subplot(gs[1, 4])
    phase_keys = ['latency_baseline','latency_serangan','latency_pemulihan']
    phases_short = ['Baseline','Serangan','Pulih']
    fab_lats = [_ddos_avg(ddos_data.get('fabric',[]),   k) for k in phase_keys]
    eth_lats = [_ddos_avg(ddos_data.get('ethereum',[]), k) for k in phase_keys]
    ax6.plot(phases_short, fab_lats, 'o-', color=FAB_COLOR, lw=2.5, ms=8, label='Fabric')
    ax6.plot(phases_short, eth_lats, 's-', color=ETH_COLOR, lw=2.5, ms=8, label='Ethereum')
    ax6.set_ylabel('ms'); ax6.set_title('DDoS — Latency Fase'); ax6.legend(fontsize=8)

    # ── Row 2: Summary table ──
    ax7 = fig.add_subplot(gs[2, :])
    ax7.axis('off')

    fab_avail = _ddos_avg(ddos_data.get('fabric',[]),   'availability')
    eth_avail = _ddos_avg(ddos_data.get('ethereum',[]), 'availability')

    table_data = [
        ['Aspek Pengujian', 'Ethereum Sepolia', 'Hyperledger Fabric', 'Unggul'],
        ['Spam — Avg Latency (Sequential)',
         f"{df_eth_seq['latency_ms'].mean():,.0f} ms",
         f"{df_fab_seq['latency_ms'].mean():,.0f} ms",
         'Fabric ✓' if df_fab_seq['latency_ms'].mean() < df_eth_seq['latency_ms'].mean() else 'Ethereum ✓'],
        ['Load Test — Avg Throughput',
         f"{df_load[df_load['platform']=='ethereum']['throughput'].mean():.2f} req/s",
         f"{df_load[df_load['platform']=='fabric']['throughput'].mean():.2f} req/s",
         'Fabric ✓' if df_load[df_load['platform']=='fabric']['throughput'].mean() >
                       df_load[df_load['platform']=='ethereum']['throughput'].mean() else 'Ethereum ✓'],
        ['Access Control — Pass Rate',
         f"{lulus}/{total_ac} ({lulus/total_ac*100:.1f}%)" if total_ac else '—',
         'Sama (1 sistem)', '—'],
        ['Document Integrity — Valid Rate',
         f"{eth_ok}/{len(df_eth_int)} ({eth_ok/len(df_eth_int)*100:.1f}%)" if len(df_eth_int) else '—',
         f"{fab_ok}/{len(df_fab_int)} ({fab_ok/len(df_fab_int)*100:.1f}%)" if len(df_fab_int) else '—',
         'Fabric ✓' if (fab_ok/len(df_fab_int) if len(df_fab_int) else 0) >=
                       (eth_ok/len(df_eth_int) if len(df_eth_int) else 0) else 'Ethereum ✓'],
        ['DDoS — Availability',
         f'{eth_avail:.1f}%',
         f'{fab_avail:.1f}%',
         'Fabric ✓' if fab_avail >= eth_avail else 'Ethereum ✓'],
    ]

    table = ax7.table(cellText=table_data[1:], colLabels=table_data[0],
                      cellLoc='center', loc='center')
    table.auto_set_font_size(False); table.set_fontsize(9.5); table.scale(1, 1.9)
    for (row, col), cell in table.get_celld().items():
        cell.set_facecolor(BG_PANEL); cell.set_edgecolor('#AAAACC')
        cell.set_text_props(color=TEXT_LIGHT)
        if row == 0:
            cell.set_facecolor(BG_DARK)
            cell.set_text_props(color=ACCENT_GOLD, fontweight='bold')
        elif col == 3:
            txt = cell.get_text().get_text()
            if 'Fabric' in txt:
                cell.set_facecolor('#1A3A2A'); cell.set_text_props(color=FAB_COLOR, fontweight='bold')
            elif 'Ethereum' in txt:
                cell.set_facecolor('#1A2060'); cell.set_text_props(color=ETH_COLOR, fontweight='bold')
    ax7.set_title('Tabel Ringkasan Perbandingan', pad=8, fontsize=11)

    watermark(fig)
    return save_fig(fig, 'grafik_13_dashboard_keseluruhan.png')


# ══════════════════════════════════════════════════════════════
# EXPORT EXCEL
# ══════════════════════════════════════════════════════════════

def export_to_excel(image_paths):
    wb = Workbook(); ws_cover = wb.active; ws_cover.title = 'Cover'
    NAVY     = PatternFill('solid', fgColor='1A2744')
    GREY     = PatternFill('solid', fgColor='F2F2F2')
    WHITE    = PatternFill('solid', fgColor='FFFFFF')
    ft_title = Font(name='Times New Roman', size=16, bold=True, color='FFFFFF')
    ft_body  = Font(name='Times New Roman', size=11)
    center   = Alignment(horizontal='center', vertical='center', wrap_text=True)
    thin     = Side(style='thin')
    brd      = Border(thin, thin, thin, thin)

    ws_cover.column_dimensions['A'].width = 50
    ws_cover.column_dimensions['B'].width = 28
    ws_cover['A1'] = 'LAPORAN GRAFIK HASIL PENGUJIAN BLOCKCHAIN'
    ws_cover['A1'].font = ft_title; ws_cover['A1'].fill = NAVY
    ws_cover['A1'].alignment = center; ws_cover.merge_cells('A1:B1')
    ws_cover.row_dimensions[1].height = 35

    for i, (k, v) in enumerate([
        ('Judul',          'Perbandingan Ethereum Sepolia vs Hyperledger Fabric'),
        ('Program Studi',  'Informatika — UAJY'),
        ('Tanggal Cetak',  datetime.now().strftime('%d %B %Y, %H:%M')),
        ('Total Grafik',   str(len(image_paths))),
    ], start=3):
        ws_cover.row_dimensions[i].height = 22
        for col, val in [(1, k), (2, v)]:
            c = ws_cover.cell(i, col, val)
            c.font = ft_body; c.alignment = center; c.border = brd
            c.fill = GREY if i % 2 == 1 else WHITE

    labels = {
        'grafik_01': 'Spam Latency Distribusi',
        'grafik_02': 'Spam Perbandingan Metrik',
        'grafik_03': 'Load Response Time',
        'grafik_04': 'Load Throughput',
        'grafik_05': 'Load Error Rate',
        'grafik_06': 'Access Control Hasil',
        'grafik_07': 'Access Control Latency',
        'grafik_08': 'Integrity Summary',
        'grafik_09': 'Integrity per Doctype',
        'grafik_10': 'DDoS Availability',
        'grafik_11': 'DDoS Latency Fase',
        'grafik_12': 'DDoS Platform Comparison',
        'grafik_13': 'Dashboard Keseluruhan',
    }
    for path in image_paths:
        base = os.path.splitext(os.path.basename(path))[0]
        key  = '_'.join(base.split('_')[:2])
        ws   = wb.create_sheet(title=labels.get(key, base[:28]))
        ws.column_dimensions['A'].width = 3
        tc = ws.cell(1, 1, labels.get(key, base).upper())
        tc.font = Font(name='Times New Roman', size=12, bold=True, color='FFFFFF')
        tc.fill = NAVY; tc.alignment = center
        ws.merge_cells('A1:L1'); ws.row_dimensions[1].height = 25
        if os.path.exists(path):
            img = XLImage(path)
            img.width = 850; img.height = int(img.width * 0.62)
            ws.add_image(img, 'A3')

    out = os.path.join(OUTPUT_DIR, 'laporan_grafik_pengujian.xlsx')
    wb.save(out)
    print(f"\n  ✓ Laporan Excel: {out}")
    return out


# ══════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════

def main():
    print('\n' + '='*65)
    print('  ANALISIS & VISUALISASI HASIL PENGUJIAN BLOCKCHAIN')
    print('  Tugas Akhir — Informatika UAJY')
    print(f'  {datetime.now().strftime("%d %B %Y, %H:%M")}')
    print('='*65)

    print('\n[1] Memuat data...')
    df_eth_seq = load_spam_data('ethereum', 'sequential')
    df_eth_con = load_spam_data('ethereum', 'concurrent')
    df_fab_seq = load_spam_data('fabric',   'sequential')
    df_fab_con = load_spam_data('fabric',   'concurrent')
    df_load    = load_load_test_summary()
    df_ac      = load_access_control_data()
    int_data   = load_integrity_data()
    df_eth_int = int_data.get('ethereum', _dummy_integrity('ethereum'))
    df_fab_int = int_data.get('fabric',   _dummy_integrity('fabric'))
    ddos_data  = load_ddos_data()

    print(f'\n  Iterasi yang termuat:')
    print(f'    Spam ETH seq/con: {getattr(df_eth_seq,"_n_iterasi","?")} / {getattr(df_eth_con,"_n_iterasi","?")} run')
    print(f'    Spam FAB seq/con: {getattr(df_fab_seq,"_n_iterasi","?")} / {getattr(df_fab_con,"_n_iterasi","?")} run')
    print(f'    DDoS Fabric     : {len(ddos_data.get("fabric", []))} run')
    print(f'    DDoS Ethereum   : {len(ddos_data.get("ethereum", []))} run')

    print('\n[2] Membuat grafik...')
    saved = []

    print('  [2.1]  Spam — Distribusi Latency')
    saved.append(plot_spam_latency(df_eth_seq, df_eth_con, df_fab_seq, df_fab_con))

    print('  [2.2]  Spam — Perbandingan Metrik')
    saved.append(plot_spam_comparison(df_eth_seq, df_eth_con, df_fab_seq, df_fab_con))
    plt.close('all')

    print('  [2.3]  Load Test — Response Time')
    saved.append(plot_load_response_time(df_load))

    print('  [2.4]  Load Test — Throughput')
    saved.append(plot_load_throughput(df_load))

    print('  [2.5]  Load Test — Error Rate')
    saved.append(plot_load_error_rate(df_load))
    plt.close('all')

    print('  [2.6]  Access Control — Hasil Skenario')
    saved.append(plot_access_control(df_ac))

    print('  [2.7]  Access Control — Latency')
    saved.append(plot_access_control_latency(df_ac))
    plt.close('all')

    print('  [2.8]  Document Integrity — Summary')
    saved.append(plot_integrity_summary(df_eth_int, df_fab_int))

    print('  [2.9]  Document Integrity — per Tipe Dokumen')
    saved.append(plot_integrity_detail(df_eth_int, df_fab_int))
    plt.close('all')

    print('  [2.10] DDoS — Availability per Iterasi')
    saved.append(plot_ddos_availability(ddos_data))

    print('  [2.11] DDoS — Perubahan Latency per Fase')
    saved.append(plot_ddos_latency_phases(ddos_data))

    print('  [2.12] DDoS — Perbandingan Lengkap Platform')
    saved.append(plot_ddos_platform_comparison(ddos_data))
    plt.close('all')

    print('  [2.13] Dashboard Keseluruhan')
    saved.append(plot_dashboard_summary(
        df_eth_seq, df_fab_seq, df_load,
        df_ac, df_eth_int, df_fab_int, ddos_data))
    plt.close('all')

    print('\n[3] Export ke Excel...')
    export_to_excel(saved)

    print('\n' + '='*65)
    print(f'  SELESAI — {len(saved)} grafik + 1 laporan Excel')
    print(f'  Folder output: {os.path.abspath(OUTPUT_DIR)}')
    print('  File:')
    for f in saved:
        print(f'    - {os.path.basename(f)}')
    print('    - laporan_grafik_pengujian.xlsx')
    print('='*65 + '\n')


if __name__ == '__main__':
    main()