const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
require('dotenv').config();

// Khởi tạo Bot với mã Token thật của bạn
const bot = new Telegraf(process.env.BOT_TOKEN);

// Đường link máy chủ Render chạy thực tế của bạn
const BACKEND_URL = "https://lioncoin-p9rw.onrender.com";

bot.start(async (ctx) => {
    const telegramUser = ctx.from;
    const referrerId = ctx.payload; // Bắt mã ID người mời từ link ref bám đuôi

    console.log(`[Bot Live] Khách hàng nhấn Start: ${telegramUser.first_name} (UID: ${telegramUser.id})`);

    try {
        // Gọi lệnh trực tuyến lên Render để tự động đăng ký tài khoản thật và tính hoa hồng mời bạn bè
        const response = await axios.post(`${BACKEND_URL}/api/users/register`, {
            telegramId: telegramUser.id.toString(),
            username: telegramUser.username || telegramUser.first_name,
            referrerId: referrerId || null
        });

        const isNewUser = response.data.isNewUser;

        // Thiết lập tin nhắn lời chào bằng tiếng Việt mang phong cách Lion Coin của bạn
        let welcomeMessage = `🦁 <b>CHÀO MỪNG ĐẾN VỚI VƯƠNG QUỐC LION COIN!</b> 🦁\n\n`;
        welcomeMessage += `⚡ Hãy nhấn ngay vào nút <b>Play App 🦁</b> ở góc dưới bên trái màn hình chat để mở giao diện kích hoạt máy đào chu kỳ 4h/lần.\n\n`;
        welcomeMessage += `💰 Tích lũy đủ 10 LION để thực hiện đổi (Swap) sang USDT và rút trực tiếp về tài khoản Ngân hàng Việt Nam an toàn tức thì!`;
        
        if (isNewUser && referrerId) {
            welcomeMessage += `\n\n🎁 Hệ thống đã ghi nhận bạn tham gia qua mã giới thiệu của bạn bè!`;
        }

        // Gửi tin nhắn kèm nút bấm mở ứng dụng trực tiếp
        // (Link Vercel đã được @BotFather quản lý thông qua Menu Button nên ở đây chỉ cần nút WebApp mở app)
        await ctx.replyWithHTML(welcomeMessage, 
            Markup.inlineKeyboard([
                [Markup.button.webApp('Play App 🦁', 'https://vercel.app')] 
            ])
        );

    } catch (error) {
        console.error("Lỗi đồng bộ Bot với Render:", error.message);
        ctx.reply("Chào mừng bạn đến với Lion Coin! Máy chủ đang đồng bộ dữ liệu tải khoản, bạn vẫn có thể nhấn nút Menu góc dưới để mở game chơi ngay.");
    }
});

// Bật chế độ chạy ngầm trực tuyến cho Bot
bot.launch().then(() => {
    console.log('✅ [Bot Live] Hệ thống Chatbot điều hướng đã kích hoạt trực tuyến thành công!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
