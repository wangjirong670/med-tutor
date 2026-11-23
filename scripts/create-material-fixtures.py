"""Generate clearly synthetic import fixtures; no medical factual assertions."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader

out = Path('.study/fixtures')
out.mkdir(parents=True, exist_ok=True)
font_path = 'C:/Windows/Fonts/simsun.ttc'
pdfmetrics.registerFont(TTFont('Chinese', font_path, subfontIndex=0))
font = ImageFont.truetype(font_path, 44)
lines = ['合成学习材料：仅测试整理流程，不是医学事实。', '实验标签练习，假设规则：', '甲标签表示红色；乙标签表示蓝色。', '先看标签，再查颜色，不能反推未列出的标签。', '后页补充：丙标签也可表示红色。', '表格演示：', '标签      第一份记录      第二份记录', '甲        红色            绿色', '两份记录冲突，尚未查教材。']
image = Image.new('RGB', (1500, 1100), 'white')
draw = ImageDraw.Draw(image)
for i, line in enumerate(lines):
    draw.text((45, 45 + i*105), line, font=font, fill='black')
image.save(out/'synthetic-page.png')
image.save(out/'synthetic-page.jpg', quality=94)
c = canvas.Canvas(str(out/'synthetic-text.pdf'), pagesize=(700, 700))
c.setFont('Chinese', 18)
for i, line in enumerate(lines): c.drawString(30, 650-i*62, line)
c.showPage()
c.setFont('Chinese', 18)
c.drawString(30, 650, '第二页补充：甲的绿色记录是抄写错误，应记红色。')
c.drawString(30, 610, '这里只修正合成记录，不代表核对过真实教材。')
c.save()
c = canvas.Canvas(str(out/'synthetic-scan.pdf'), pagesize=(750, 550))
c.drawImage(ImageReader(image), 0, 0, width=750, height=550)
c.save()
c = canvas.Canvas(str(out/'synthetic-mixed.pdf'), pagesize=(750, 650))
c.setFont('Chinese', 18)
c.drawString(25, 620, '文字层：下方为扫描表格，不能只读标题。')
c.drawImage(ImageReader(image), 0, 30, width=750, height=550)
c.save()
(out/'notes.md').write_text('合成标签实验笔记，不是真实医学事实，也不是要交的作业。\n乱记：乙是蓝色。先看标签再找颜色。甲是红色。甲是红色，重复了一次。\n另一份笔记却说：甲是绿色。两份说法冲突，暂未核对。\n范围只到这一页，未见丙的规则，不代表丙不存在。\n请把判别步骤和易错写清楚。', encoding='utf-8')
(out/'supplement.txt').write_text('合成后页补充：甲的绿色记录是抄写错误，应记红色。丙标签也可表示红色。\n影响：前稿中把颜色反推为唯一标签的说法应修正。这里只修正合成记录，未对真实教材。', encoding='utf-8')
print(out.resolve())
