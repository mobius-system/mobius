# 对照图: 搜索定位过程中滚动容器的 scrollTop 轨迹 (修前 vs 修后)
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

before = "6801:20 6892:42 6928:88 6962:172 7037:20 7118:29 7141:42 7158:61 7192:124 7275:546 7320:1179 7362:1704 7379:20 7551:42 7583:88 7597:125 7629:174 7727:753 7786:1485 7800:2091 7836:2241 7860:2487 7939:20 8021:29 8034:42 8055:61 8078:125 8114:174 8141:321 8177:571 8191:753 8220:1232 8243:1485 8274:1917 8316:2241 8335:2487 8362:2682 8420:2765 8461:20 8525:29 8553:61 8611:174 8622:238 8683:321 8726:978 8756:1716 8786:2091 8823:2372 8855:2590 8881:2765 8954:2621 8983:3129 9013:20 9106:42 9119:20 9166:29 9196:62 9223:91 9272:256 9286:353 9305:482 9334:865 9365:1314 9397:1666 9428:1922 9489:2194 9500:2266 9531:2387 9562:2487 9656:2607 9673:2699 9694:2748 9755:2808 9767:2824 9798:2853 9827:2877 9889:2903 9901:2910 9931:2921 9962:2928 10024:2934"
after = "5005:41 5023:104 5064:295 5106:534 5171:543 5227:603 5255:691 5292:843 5368:852 5445:1003 5496:1164 5605:1650 5620:2673 5725:2683 5799:2966 5848:3277 5925:3386 5947:3487 5962:3531 5999:3563 6087:3612 6133:3625 6185:3630 6202:3631 8111:3306 8130:3292"

def parse(s):
    pts = [tuple(float(x) for x in p.split(':')) for p in s.split()]
    t0 = pts[0][0]
    return [((t - t0) / 1000, v) for t, v in pts]

fig, ax = plt.subplots(figsize=(11, 4.6), dpi=130)
for series, color, label in ((parse(before), '#ef4444', '修改前: 6 次被甩回会话顶部再滑下来'), (parse(after), '#22c55e', '修改后: 一次单调滑到位')):
    xs = [p[0] for p in series]; ys = [p[1] for p in series]
    ax.plot(xs, ys, color=color, lw=2, marker='o', ms=3, label=label)
ax.axhline(0, color='#94a3b8', lw=1, ls='--')
ax.text(0.05, 120, '会话顶部 (scrollTop=0)', fontsize=9, color='#64748b')
ax.set_xlabel('点击搜索结果后经过的时间 (秒)')
ax.set_ylabel('消息区滚动位置 scrollTop (px)')
ax.set_title('点击搜索结果 → 新标签定位时的滚动轨迹 (dev 45618, 同一命中卡片)', fontsize=12)
ax.grid(alpha=0.25)
ax.legend(loc='center right')
plt.rcParams['font.sans-serif'] = ['Noto Sans CJK JP', 'WenQuanYi Zen Hei', 'DejaVu Sans']
plt.tight_layout()
plt.savefig('/home/tianyi/imac-test/scratch/scroll-jitter/scroll-trace-compare.png')
print('ok')
