using System;

namespace N
{
    public class Report
    {
        private int _count;

#if DEBUG
        public string Describe()
#else
        internal string Describe()
#endif
        {
            return "report " + _count;
        }

        public void Add()
        {
            _count++;
        }
    }
}
