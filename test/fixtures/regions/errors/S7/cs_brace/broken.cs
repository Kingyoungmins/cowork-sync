namespace N
{
    public class Pricing
    {
        public int Calc(int x)
        {
            if (x < 0) { return 0;
            return x * 2;
        }

        public double Calc(double x)
        {
            return x * 2.0;
        }

        public string Describe()
        {
            return "pricing";
        }

        public int Twice(int x)
        {
            return Calc(x) + Calc(x);
        }
    }
}
