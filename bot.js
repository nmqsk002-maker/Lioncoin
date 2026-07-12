const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const MINI_APP_URL = process.env.MINI_APP_URL;

// API kết nối nội bộ tới server backend đang chạy trên cổng 5000 của Termux
const BACKEND_API = 'http://localhost:5000/api/users/register';

bot.start(async (ctx) => {
    const telegramUser = ctx.from;
    const referrerId = ctx.payload; // Lấy ID người mời từ link t.me/bot?start=id

    console.log(`[Bot] Có người dùng bấm Start: ${telegramUser.first_name} (ID: ${telegramUser.id})`);

    try {
        // 1. Gọi sang Server Backend để tự động tạo tài khoản và tính hoa hồng 0.50 LION cho người mời
        const response = await axios.post(BACKEND_API, {
            telegramId: telegramUser.id,
            username: telegramUser.username || telegramUser.first_name,
            referrerId: referrerId || null
        });

        const isNewUser = response.data.isNewUser;

        // 2. Thiết lập tin nhắn chào mừng theo phong cách Lion Coin của bạn
        let welcomeMessage = `🦁 <b>CHÀO MỪNG ĐẾN VỚI LION COIN!</b> 🦁\n\n`;
        welcomeMessage += `⚡ Hãy bấm nút <b>Play App</b> ngay bên dưới để mở giao diện đào xu!\n`;
        welcomeMessage += `⏳ Cơ chế đào: <b>4 giờ/lần</b>. Hãy chăm chỉ vào kích hoạt lại để tích lũy đủ 10 LION sau 3 ngày nhé.\n\n`;
        welcomeMessage += `💰 Đổi LION sang USDT trực tiếp trong ví ứng dụng và rút về ngân hàng VNĐ tức thì với mức tối thiểu cực thấp chỉ <b>0.1 USDT</b>!`;
        
        if (isNewUser && referrerId) {
            welcomeMessage += `\n\n🎁 Bạn đã nhận được quà tặng khởi đầu vì tham gia qua link giới thiệu!`;
        }

        // 3. Gửi tin nhắn kèm NÚT BẤM LỚN mở thẳng Mini App không cần bấm link text
        await ctx.replyWithHTML(welcomeMessage, 
            Markup.inlineKeyboard([
                [Markup.button.webApp('Play App 🦁', MINI_APP_URL)]
            ])
        );

    } catch (error) {
        console.error("Lỗi kết nối Backend:", error.message);
        ctx.reply("Chào mừng bạn đến với Lion Coin! Hệ thống đang cập nhật dữ liệu, bạn vẫn có thể bấm nút Menu góc dưới để trải nghiệm app.");
    }
});

// Kích hoạt chạy Bot
bot.launch().then(() => {
    console.log('✅ [Hệ thống] Bot Telegram Lion Coin đã kích hoạt thành công!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
