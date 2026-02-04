module.exports = {
    async handle(message) {
        const content = message.content.trim();
        const mathRegex = /^[0-9+\-*/().\s^%×÷]+$/;
        const operatorRegex = /[+\-*/^%×÷]/;

        if (!mathRegex.test(content) || !operatorRegex.test(content)) {
            return false;
        }
        try {
            const evalStr = content
                .replace(/×/g, '*')
                .replace(/÷/g, '/')
                .replace(/\^/g, '**');

            const result = new Function('return ' + evalStr)();

            if (result !== undefined && !isNaN(result) && isFinite(result)) {
                if (result.toString() === content) return false;

                await message.channel.send(result.toString());
                return true;
            }
        } catch (e) {
            return false;
        }
        return false;
    }
};
