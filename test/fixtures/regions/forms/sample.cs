// 한글 주석: 가격 계산 😀
namespace Forms
{
    public static class Sample
    {
        public const string Greeting = "‘hello’ and “world”";
        public const string Separated = @"first second";

        public static int Total(int[] prices)
        {
            // 합계
            var sum = 0;
            foreach (var p in prices) { sum += p; }
            return sum;
        }
    }
}
